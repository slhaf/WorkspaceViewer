import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";

describe("agent config", () => {
  it("allows paired agents before any workspace is configured", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "workspace-viewer-config-"));
    const configPath = path.join(dir, "config.json");
    await saveConfig({
      agent: {
        agentId: "agent_test",
        agentToken: "secret",
        serverBaseUrl: "https://worker.example.com"
      },
      workspaces: []
    }, configPath);

    const loaded = await loadConfig(configPath);
    expect(loaded.workspaces).toEqual([]);
    expect(await readFile(configPath, "utf8")).toContain("agent_test");
  });
});
