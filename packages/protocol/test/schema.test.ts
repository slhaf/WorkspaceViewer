import { describe, expect, it } from "vitest";
import {
  batchExecInputSchema,
  ACTION_TOOL_NAMES,
  AGENT_TOOL_NAMES,
  completeAgentPairingRequestSchema,
  context7QueryDocsInputSchema,
  context7ResolveLibraryIdInputSchema,
  createAgentPairingCodeResultSchema,
  describeWorkspaceChangesInputSchema,
  inspectWorkspaceDiffInputSchema,
  listTreeInputSchema,
  OAUTH_SCOPE,
  searchFileInputSchema,
  unpairAgentRequestSchema,
  unpairAgentResponseSchema,
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
    expect(completeAgentPairingRequestSchema.parse({
      pairingCode: "ABCD-EFGH",
      workspaces: [{
        workspaceId: "ws_test",
        displayName: "Test Workspace",
        accessMode: "read_only",
        languages: ["typescript"]
      }]
    }).workspaces?.[0]?.workspaceId).toBe("ws_test");
    expect(createAgentPairingCodeResultSchema.parse({
      pairingCode: "ABCD-EFGH",
      expiresAt: "2026-05-20T12:34:56.000Z",
      commandHint: "workspace-viewer-agent pair ABCD-EFGH"
    }).pairingCode).toBe("ABCD-EFGH");
    expect(unpairAgentRequestSchema.parse({ agentId: "agent_test" }).agentId).toBe("agent_test");
    expect(unpairAgentResponseSchema.parse({ ok: true }).ok).toBe(true);
  });

  it("declares Git and Context7 tool boundaries", () => {
    expect(AGENT_TOOL_NAMES).toContain("describeWorkspaceChanges");
    expect(AGENT_TOOL_NAMES).toContain("inspectWorkspaceDiff");
    expect(AGENT_TOOL_NAMES).not.toContain("context7QueryDocs");
    expect(ACTION_TOOL_NAMES).toContain("context7ResolveLibraryId");
    expect(ACTION_TOOL_NAMES).toContain("context7QueryDocs");
  });

  it("caps Git and Context7 inputs", () => {
    expect(() => describeWorkspaceChangesInputSchema.parse({
      workspaceId: "ws",
      maxFiles: 999
    })).toThrow();
    expect(() => inspectWorkspaceDiffInputSchema.parse({
      workspaceId: "ws",
      maxBytes: 999999999
    })).toThrow();
    expect(() => context7ResolveLibraryIdInputSchema.parse({
      libraryName: "react",
      query: "hooks",
      maxResults: 999
    })).toThrow();
    expect(() => context7QueryDocsInputSchema.parse({
      libraryId: "/facebook/react",
      query: "x".repeat(9999)
    })).toThrow();
  });
});
