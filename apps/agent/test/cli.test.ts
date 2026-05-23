import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isConfigWriteEvent, pair, unpair, WORKSPACE_VIEWER_MCP_URL } from "../src/cli.js";
import { loadConfig, saveConfig } from "../src/config.js";

describe("agent cli pairing", () => {
  it("pairs against the built-in server and preserves workspaces", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "workspace-viewer-cli-"));
    const configPath = path.join(dir, "config.json");
    await saveConfig({
      workspaces: [{
        workspaceId: "ws_test",
        displayName: "Test",
        rootPath: dir,
        accessMode: "read_only"
      }]
    }, configPath);
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      requests.push({
        url: input.toString(),
        body: JSON.parse(init?.body as string)
      });
      return Response.json({
        agentId: "agent_test",
        agentToken: "token_test",
        serverBaseUrl: "https://ignored.example.com"
      });
    };

    await pair(["ABCD-EFGH", "--config", configPath], fetchFn, () => undefined);

    expect(requests).toEqual([{
      url: "https://workspace-viewer.slhafzjw-workspace-viewer.workers.dev/agent/pair/complete",
      body: {
        pairingCode: "ABCD-EFGH",
        workspaces: [{
          workspaceId: "ws_test",
          displayName: "Test",
          accessMode: "read_only"
        }]
      }
    }]);
    const config = await loadConfig(configPath);
    expect(config.agent).toMatchObject({
      agentId: "agent_test",
      agentToken: "token_test",
      serverBaseUrl: WORKSPACE_VIEWER_MCP_URL
    });
    expect(config.workspaces[0]?.workspaceId).toBe("ws_test");
  });

  it("rejects the removed --server option", async () => {
    const previousExitCode = process.exitCode;
    let called = false;
    const fetchFn: typeof fetch = async () => {
      called = true;
      return Response.json({});
    };

    await pair(["ABCD-EFGH", "--server"], fetchFn, () => undefined);

    expect(called).toBe(false);
    expect(process.exitCode).toBe(2);
    process.exitCode = previousExitCode;
  });

  it("unpairs only after server success and keeps workspaces", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "workspace-viewer-cli-"));
    const configPath = path.join(dir, "config.json");
    await saveConfig({
      agent: {
        agentId: "agent_test",
        agentToken: "token_test",
        serverBaseUrl: WORKSPACE_VIEWER_MCP_URL
      },
      workspaces: [{
        workspaceId: "ws_test",
        displayName: "Test",
        rootPath: dir,
        accessMode: "read_only"
      }]
    }, configPath);
    const fetchFn: typeof fetch = async () => Response.json({ ok: true });

    await unpair(["--config", configPath], fetchFn, () => undefined);

    const config = await loadConfig(configPath);
    expect(config.agent).toBeUndefined();
    expect(config.workspaces[0]?.workspaceId).toBe("ws_test");
  });

  it("keeps local credentials when unpair fails remotely", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "workspace-viewer-cli-"));
    const configPath = path.join(dir, "config.json");
    await saveConfig({
      agent: {
        agentId: "agent_test",
        agentToken: "token_test",
        serverBaseUrl: WORKSPACE_VIEWER_MCP_URL
      },
      workspaces: []
    }, configPath);
    const before = await readFile(configPath, "utf8");
    const fetchFn: typeof fetch = async () => new Response("nope", { status: 403 });

    await expect(unpair(["--config", configPath], fetchFn, () => undefined)).rejects.toThrow("Unpair failed");

    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("treats atomic config temp-file writes as config changes", () => {
    expect(isConfigWriteEvent("config.json", "config.json")).toBe(true);
    expect(isConfigWriteEvent("config.json.123.tmp", "config.json")).toBe(true);
    expect(isConfigWriteEvent("other.json", "config.json")).toBe(false);
  });
});
