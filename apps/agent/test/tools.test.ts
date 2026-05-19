import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/config.js";
import { executeTool } from "../src/tools.js";

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
});
