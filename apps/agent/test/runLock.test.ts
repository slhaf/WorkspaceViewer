import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireAgentRunLock } from "../src/runLock.js";

describe("agent run lock", () => {
  it("rejects a second active run for the same config", async () => {
    const configPath = await tempConfigPath();
    const lock = await acquireAgentRunLock(configPath);
    try {
      await expect(acquireAgentRunLock(configPath)).rejects.toThrow("already running");
    } finally {
      await lock.release();
    }

    const next = await acquireAgentRunLock(configPath);
    await next.release();
  });

  it("removes stale locks before acquiring", async () => {
    const configPath = await tempConfigPath();
    const lockPath = `${configPath}.run.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: 999999999,
      configPath,
      createdAt: "2026-01-01T00:00:00.000Z"
    }), "utf8");

    const lock = await acquireAgentRunLock(configPath);
    try {
      const raw = await readFile(lockPath, "utf8");
      expect(JSON.parse(raw)).toMatchObject({
        pid: process.pid,
        configPath: path.resolve(configPath)
      });
    } finally {
      await lock.release();
    }
  });
});

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "workspace-viewer-run-lock-"));
  return path.join(dir, "config.json");
}
