import { describe, expect, it } from "vitest";
import {
  batchExecInputSchema,
  completeAgentPairingRequestSchema,
  createAgentPairingCodeResultSchema,
  listTreeInputSchema,
  OAUTH_SCOPE,
  searchFileInputSchema,
  workspaceToolErrorSchema
} from "../src/index.js";

describe("protocol schemas", () => {
  it("caps listTree depth", () => {
    expect(() => listTreeInputSchema.parse({ workspaceId: "ws", depth: 99 })).toThrow();
  });

  it("caps content search query and options", () => {
    expect(() => searchFileInputSchema.parse({
      workspaceId: "ws",
      mode: "content",
      query: "x".repeat(257)
    })).toThrow();
    expect(searchFileInputSchema.parse({
      workspaceId: "ws",
      mode: "content",
      query: "needle",
      maxResults: 10,
      contextLines: 1
    }).query).toBe("needle");
  });

  it("rejects recursive batchExec operations", () => {
    expect(() => batchExecInputSchema.parse({
      workspaceId: "ws",
      operations: [{ id: "nested", tool: "batchExec", input: {} }]
    })).toThrow();
  });

  it("validates standard workspace errors", () => {
    expect(workspaceToolErrorSchema.parse({
      code: "PATH_OUTSIDE_WORKSPACE",
      message: "outside"
    }).code).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("uses the v1 OAuth scope for workspace access", () => {
    expect(OAUTH_SCOPE).toBe("workspace.access");
  });

  it("validates pairing payloads", () => {
    expect(completeAgentPairingRequestSchema.parse({
      pairingCode: "ABCD-EFGH"
    }).pairingCode).toBe("ABCD-EFGH");
    expect(createAgentPairingCodeResultSchema.parse({
      pairingCode: "ABCD-EFGH",
      expiresAt: "2026-05-20T12:34:56.000Z",
      commandHint: "workspace-viewer-agent login ABCD-EFGH --server https://example.com"
    }).pairingCode).toBe("ABCD-EFGH");
  });
});
