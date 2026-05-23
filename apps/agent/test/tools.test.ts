import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/config.js";
import { executeTool } from "../src/tools.js";

const execFileAsync = promisify(execFile);

async function makeConfig(): Promise<{ config: AgentConfig; root: string; outside: string }> {
  const base = path.join(tmpdir(), `workspace-viewer-${crypto.randomUUID()}`);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "alpha\nneedle here\nomega\n");
  await writeFile(path.join(root, "src", "large.txt"), "x".repeat(1024 * 1024 + 1));
  await writeFile(path.join(root, "src", "binary.bin"), Buffer.from([0, 1, 2, 3, 4]));
  await writeFile(path.join(root, "node_modules", "hidden.txt"), "needle hidden\n");
  await writeFile(path.join(outside, "secret.txt"), "secret\n");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "src", "secret-link.txt"));
  return {
    root,
    outside,
    config: {
      agent: {
        agentId: "agent_dev",
        agentToken: "dev-agent-token",
        serverBaseUrl: "http://localhost:8787"
      },
      workspaces: [{
        workspaceId: "ws_dev",
        displayName: "Fixture",
        rootPath: root,
        accessMode: "read_only",
        languages: ["typescript"],
        ignore: ["node_modules"]
      }]
    }
  };
}

describe("agent tools", () => {
  it("guards path traversal and symlink escape", async () => {
    const { config } = await makeConfig();
    await expect(executeTool(config, "inspectFile", {
      workspaceId: "ws_dev",
      path: "../outside/secret.txt"
    })).rejects.toMatchObject({ toolError: { code: "PATH_OUTSIDE_WORKSPACE" } });

    await expect(executeTool(config, "inspectFile", {
      workspaceId: "ws_dev",
      path: "src/secret-link.txt"
    })).rejects.toMatchObject({ toolError: { code: "PATH_OUTSIDE_WORKSPACE" } });
  });

  it("searches content line-by-line while skipping ignored, large, and binary files", async () => {
    const { config } = await makeConfig();
    const result = await executeTool(config, "searchFile", {
      workspaceId: "ws_dev",
      mode: "content",
      query: "needle",
      contextLines: 1
    }) as { matches: Array<{ path: string; line: number; before?: string[]; after?: string[] }> };

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      path: "src/index.ts",
      line: 2,
      before: ["alpha"],
      after: ["omega"]
    });
  });

  it("returns partial batch results", async () => {
    const { config } = await makeConfig();
    const result = await executeTool(config, "batchExec", {
      workspaceId: "ws_dev",
      operations: [
        { id: "ok", tool: "inspectFile", input: { path: "src/index.ts", startLine: 1, endLine: 1 } },
        { id: "bad", tool: "inspectFile", input: { path: "missing.ts" } }
      ]
    }) as { results: Array<{ id: string; ok: boolean; error?: { code: string } }> };

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ id: "ok", ok: true });
    expect(result.results[1]).toMatchObject({ id: "bad", ok: false, error: { code: "FILE_NOT_FOUND" } });
  });

  it("runs Git status and diff operations in batch", async () => {
    const { config, root } = await makeConfig();
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test User");
    await git(root, "add", "src/index.ts");
    await git(root, "commit", "-m", "initial");
    await writeFile(path.join(root, "src", "index.ts"), "alpha\nbatched\nomega\n");

    const result = await executeTool(config, "batchExec", {
      workspaceId: "ws_dev",
      operations: [
        { id: "changes", tool: "describeWorkspaceChanges", input: { includeUntracked: true } },
        { id: "diff", tool: "inspectWorkspaceDiff", input: { path: "src/index.ts" } }
      ]
    }) as {
      results: Array<{ id: string; ok: boolean; result?: { files?: Array<{ path: string }>; diff?: string } }>;
    };

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ id: "changes", ok: true });
    expect(result.results[0]?.result?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/index.ts" })
    ]));
    expect(result.results[1]).toMatchObject({
      id: "diff",
      ok: true
    });
    expect(result.results[1]?.result?.diff).toContain("+batched");
  });

  it("returns non-Git status without throwing", async () => {
    const { config } = await makeConfig();
    const result = await executeTool(config, "describeWorkspaceChanges", {
      workspaceId: "ws_dev"
    }) as { isGitRepository: boolean; files: unknown[]; truncated: boolean };

    expect(result).toEqual({ isGitRepository: false, files: [], truncated: false });
  });

  it("summarizes Git changes and bounded diffs", async () => {
    const { config, root } = await makeConfig();
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test User");
    await git(root, "add", "src/index.ts");
    await git(root, "commit", "-m", "initial");
    await writeFile(path.join(root, "src", "index.ts"), "alpha\nchanged\nomega\n");
    await writeFile(path.join(root, "src", "staged.ts"), "staged\n");
    await git(root, "add", "src/staged.ts");
    await writeFile(path.join(root, "src", "untracked.ts"), "new\n");

    const changes = await executeTool(config, "describeWorkspaceChanges", {
      workspaceId: "ws_dev",
      includeUntracked: true
    }) as {
      isGitRepository: boolean;
      files: Array<{ path: string; status: string; staged: boolean; unstaged: boolean }>;
    };

    expect(changes.isGitRepository).toBe(true);
    expect(changes.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/index.ts", status: "modified", staged: false, unstaged: true }),
      expect.objectContaining({ path: "src/staged.ts", status: "added", staged: true, unstaged: false }),
      expect.objectContaining({ path: "src/untracked.ts", status: "untracked", staged: false, unstaged: true })
    ]));

    const diff = await executeTool(config, "inspectWorkspaceDiff", {
      workspaceId: "ws_dev",
      path: "src/index.ts"
    }) as { path: string; staged: boolean; diff: string; truncated: boolean };
    expect(diff.path).toBe("src/index.ts");
    expect(diff.staged).toBe(false);
    expect(diff.diff).toContain("-needle here");
    expect(diff.diff).toContain("+changed");

    const staged = await executeTool(config, "inspectWorkspaceDiff", {
      workspaceId: "ws_dev",
      path: "src/staged.ts",
      staged: true
    }) as { diff: string };
    expect(staged.diff).toContain("+staged");
  });

  it("guards Git diff paths without requiring the file to exist", async () => {
    const { config, root } = await makeConfig();
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test User");
    await git(root, "add", "src/index.ts");
    await git(root, "commit", "-m", "initial");
    await rm(path.join(root, "src", "index.ts"));

    const deleted = await executeTool(config, "inspectWorkspaceDiff", {
      workspaceId: "ws_dev",
      path: "src/index.ts"
    }) as { diff: string };
    expect(deleted.diff).toContain("deleted file");

    await expect(executeTool(config, "inspectWorkspaceDiff", {
      workspaceId: "ws_dev",
      path: "../outside/secret.txt"
    })).rejects.toMatchObject({ toolError: { code: "PATH_OUTSIDE_WORKSPACE" } });
    await expect(executeTool(config, "inspectWorkspaceDiff", {
      workspaceId: "ws_dev",
      path: "node_modules/hidden.txt"
    })).rejects.toMatchObject({ toolError: { code: "PATH_IGNORED" } });
  });
});

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}
