import { describe, expect, it } from "vitest";
import {
  batchExecInputSchema,
  listTreeInputSchema,
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
});
