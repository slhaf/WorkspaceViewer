import { z } from "zod";

export const WORKSPACE_TOOL_NAMES = [
  "listWorkspaces",
  "createAgentPairingCode",
  "describeWorkspace",
  "listTree",
  "inspectFile",
  "searchFile",
  "batchExec"
] as const;

export const AGENT_TOOL_NAMES = [
  "describeWorkspace",
  "listTree",
  "inspectFile",
  "searchFile",
  "batchExec"
] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const OAUTH_SCOPE = "workspace.access" as const;

export const LIMITS = {
  listTree: {
    maxDepth: 4,
    maxEntries: 1000,
    maxUncompressedResultBytes: 256 * 1024
  },
  inspectFile: {
    maxLines: 400,
    maxFileBytes: 1024 * 1024,
    maxUncompressedResultBytes: 128 * 1024
  },
  searchFile: {
    maxQueryLength: 256,
    maxResults: 50,
    maxContextLines: 3,
    searchTimeoutMs: 5000,
    maxFileBytes: 1024 * 1024,
    binaryProbeBytes: 8192,
    maxUncompressedResultBytes: 128 * 1024
  },
  batchExec: {
    maxOperations: 8,
    maxParallelism: 4,
    maxTotalTimeoutMs: 10000,
    maxUncompressedResultBytes: 512 * 1024
  },
  relay: {
    maxCompressedPayloadBytes: 512 * 1024,
    maxUncompressedPayloadBytes: 1024 * 1024,
    defaultTimeoutMs: 10000
  }
} as const;

export const workspaceToolErrorCodeSchema = z.enum([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_FORBIDDEN",
  "PATH_OUTSIDE_WORKSPACE",
  "PATH_IGNORED",
  "FILE_NOT_FOUND",
  "FILE_TOO_LARGE",
  "INVALID_PARAMS",
  "SEARCH_TIMEOUT",
  "RESULT_TOO_LARGE",
  "TOOL_TIMEOUT",
  "INTERNAL_ERROR"
]);

export const relayErrorCodeSchema = z.enum([
  "AGENT_OFFLINE",
  "AGENT_BUSY",
  "AGENT_TIMEOUT",
  "AGENT_PROTOCOL_ERROR",
  "COMPRESSED_RESULT_TOO_LARGE",
  "INTERNAL_ERROR"
]);

export const workspaceToolErrorSchema = z.object({
  code: workspaceToolErrorCodeSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional()
});

export type WorkspaceToolError = z.infer<typeof workspaceToolErrorSchema>;

export const relayErrorSchema = z.object({
  code: relayErrorCodeSchema,
  message: z.string()
});

export type RelayError = z.infer<typeof relayErrorSchema>;

export const listWorkspacesInputSchema = z.object({
  includeOffline: z.boolean().optional()
});

export const listWorkspacesResultSchema = z.object({
  workspaces: z.array(z.object({
    workspaceId: z.string(),
    displayName: z.string(),
    agentId: z.string(),
    agentDisplayName: z.string().optional(),
    agentOnline: z.boolean(),
    languages: z.array(z.string()).optional()
  }))
});

export const createAgentPairingCodeInputSchema = z.object({
  agentDisplayName: z.string().min(1).max(100).optional()
});

export const createAgentPairingCodeResultSchema = z.object({
  pairingCode: z.string(),
  expiresAt: z.string(),
  commandHint: z.string()
});

export const describeWorkspaceInputSchema = z.object({
  workspaceId: z.string()
});

export const describeWorkspaceResultSchema = z.object({
  workspaceId: z.string(),
  displayName: z.string(),
  languages: z.array(z.string()).optional(),
  rootEntries: z.array(z.object({
    name: z.string(),
    type: z.enum(["file", "directory"])
  })),
  markers: z.array(z.string()).optional()
});

export const listTreeInputSchema = z.object({
  workspaceId: z.string(),
  path: z.string().optional(),
  depth: z.number().int().min(0).max(LIMITS.listTree.maxDepth).optional(),
  includeFiles: z.boolean().optional()
});

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeEntry[];
}

export const treeEntrySchema: z.ZodType<TreeEntry> = z.lazy(() => z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory"]),
  children: z.array(treeEntrySchema).optional()
}) as z.ZodType<TreeEntry>);

export const listTreeResultSchema = z.object({
  path: z.string(),
  depth: z.number().int(),
  entries: z.array(treeEntrySchema),
  truncated: z.boolean()
});

export const inspectFileInputSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional()
});

export const inspectFileResultSchema = z.object({
  path: z.string(),
  language: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(0),
  content: z.string(),
  truncated: z.boolean()
});

export const searchFileInputSchema = z.object({
  workspaceId: z.string(),
  mode: z.enum(["path", "content"]),
  query: z.string().min(1).max(LIMITS.searchFile.maxQueryLength),
  pathPrefix: z.string().optional(),
  fileGlob: z.array(z.string()).optional(),
  maxResults: z.number().int().min(1).max(LIMITS.searchFile.maxResults).optional(),
  contextLines: z.number().int().min(0).max(LIMITS.searchFile.maxContextLines).optional()
});

export const searchPathResultSchema = z.object({
  mode: z.literal("path"),
  query: z.string(),
  matches: z.array(z.object({
    path: z.string(),
    name: z.string(),
    type: z.enum(["file", "directory"])
  })),
  truncated: z.boolean()
});

export const searchContentResultSchema = z.object({
  mode: z.literal("content"),
  query: z.string(),
  matches: z.array(z.object({
    path: z.string(),
    line: z.number().int().min(1),
    preview: z.string(),
    before: z.array(z.string()).optional(),
    after: z.array(z.string()).optional()
  })),
  truncated: z.boolean()
});

export const searchFileResultSchema = z.discriminatedUnion("mode", [
  searchPathResultSchema,
  searchContentResultSchema
]);

export const batchOperationSchema = z.discriminatedUnion("tool", [
  z.object({
    id: z.string().min(1),
    tool: z.literal("describeWorkspace"),
    input: describeWorkspaceInputSchema.omit({ workspaceId: true })
  }),
  z.object({
    id: z.string().min(1),
    tool: z.literal("listTree"),
    input: listTreeInputSchema.omit({ workspaceId: true })
  }),
  z.object({
    id: z.string().min(1),
    tool: z.literal("inspectFile"),
    input: inspectFileInputSchema.omit({ workspaceId: true })
  }),
  z.object({
    id: z.string().min(1),
    tool: z.literal("searchFile"),
    input: searchFileInputSchema.omit({ workspaceId: true })
  })
]);

export const batchExecInputSchema = z.object({
  workspaceId: z.string(),
  operations: z.array(batchOperationSchema).min(1).max(LIMITS.batchExec.maxOperations)
});

export const batchExecResultSchema = z.object({
  results: z.array(z.object({
    id: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: workspaceToolErrorSchema.optional()
  }))
});

export const inputSchemas = {
  listWorkspaces: listWorkspacesInputSchema,
  createAgentPairingCode: createAgentPairingCodeInputSchema,
  describeWorkspace: describeWorkspaceInputSchema,
  listTree: listTreeInputSchema,
  inspectFile: inspectFileInputSchema,
  searchFile: searchFileInputSchema,
  batchExec: batchExecInputSchema
} as const;

export const resultSchemas = {
  listWorkspaces: listWorkspacesResultSchema,
  createAgentPairingCode: createAgentPairingCodeResultSchema,
  describeWorkspace: describeWorkspaceResultSchema,
  listTree: listTreeResultSchema,
  inspectFile: inspectFileResultSchema,
  searchFile: searchFileResultSchema,
  batchExec: batchExecResultSchema
} as const;

export const agentToolRequestSchema = z.object({
  type: z.literal("tool_request"),
  requestId: z.string(),
  workspaceId: z.string(),
  tool: z.enum(AGENT_TOOL_NAMES),
  input: z.unknown(),
  timeoutMs: z.number().int().positive()
});

export type AgentToolRequest = z.infer<typeof agentToolRequestSchema>;

export const agentToolResultHeaderSchema = z.object({
  type: z.literal("tool_result"),
  requestId: z.string(),
  ok: z.boolean(),
  encoding: z.literal("gzip"),
  compressedBytes: z.number().int().nonnegative(),
  uncompressedBytes: z.number().int().nonnegative(),
  error: workspaceToolErrorSchema.optional()
});

export type AgentToolResultHeader = z.infer<typeof agentToolResultHeaderSchema>;

export const agentWorkspaceSummarySchema = z.object({
  workspaceId: z.string(),
  displayName: z.string(),
  accessMode: z.literal("read_only"),
  languages: z.array(z.string()).optional()
});

export type AgentWorkspaceSummary = z.infer<typeof agentWorkspaceSummarySchema>;

export const agentHelloMessageSchema = z.object({
  type: z.literal("agent_hello"),
  agentId: z.string(),
  workspaces: z.array(agentWorkspaceSummarySchema)
});

export const agentWorkspaceSyncMessageSchema = z.object({
  type: z.literal("workspace_sync"),
  agentId: z.string(),
  workspaces: z.array(agentWorkspaceSummarySchema)
});

export const agentControlMessageSchema = z.discriminatedUnion("type", [
  agentHelloMessageSchema,
  agentWorkspaceSyncMessageSchema
]);

export type AgentControlMessage = z.infer<typeof agentControlMessageSchema>;

export const completeAgentPairingRequestSchema = z.object({
  pairingCode: z.string().min(1),
  agentDisplayName: z.string().min(1).max(100).optional(),
  workspaces: z.array(agentWorkspaceSummarySchema).optional()
});

export type CompleteAgentPairingRequest = z.infer<typeof completeAgentPairingRequestSchema>;

export const completeAgentPairingResponseSchema = z.object({
  agentId: z.string(),
  agentToken: z.string(),
  serverBaseUrl: z.string().url()
});

export type CompleteAgentPairingResponse = z.infer<typeof completeAgentPairingResponseSchema>;

export interface DispatchRequest {
  requestId: string;
  userId: string;
  agentId: string;
  workspaceId: string;
  tool: AgentToolName;
  input: unknown;
  timeoutMs: number;
}

export type DispatchResponse =
  | {
      requestId: string;
      ok: true;
      encoding: "gzip";
      compressedPayload: ArrayBuffer;
      uncompressedBytes: number;
    }
  | {
      requestId: string;
      ok: false;
      error: RelayError | WorkspaceToolError;
    };

export function workspaceError(
  code: WorkspaceToolError["code"],
  message: string,
  details?: Record<string, unknown>
): WorkspaceToolError {
  return details ? { code, message, details } : { code, message };
}

export function relayError(code: RelayError["code"], message: string): RelayError {
  return { code, message };
}

export function assertJsonByteLimit(value: unknown, maxBytes: number): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > maxBytes) {
    throw new Error(`JSON result exceeds ${maxBytes} bytes`);
  }
}
