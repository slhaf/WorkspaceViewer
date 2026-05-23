import { z } from "zod";

export const WORKSPACE_TOOL_NAMES = [
  "listWorkspaces",
  "createAgentPairingCode",
  "describeWorkspace",
  "listTree",
  "inspectFile",
  "searchFile",
  "batchExec",
  "describeWorkspaceChanges",
  "inspectWorkspaceDiff"
] as const;

export const AGENT_TOOL_NAMES = [
  "describeWorkspace",
  "listTree",
  "inspectFile",
  "searchFile",
  "batchExec",
  "describeWorkspaceChanges",
  "inspectWorkspaceDiff"
] as const;

export const CONTEXT7_TOOL_NAMES = [
  "context7ResolveLibraryId",
  "context7QueryDocs"
] as const;

export const ACTION_TOOL_NAMES = [
  ...WORKSPACE_TOOL_NAMES,
  ...CONTEXT7_TOOL_NAMES
] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];
export type Context7ToolName = (typeof CONTEXT7_TOOL_NAMES)[number];
export type ActionToolName = (typeof ACTION_TOOL_NAMES)[number];

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
  gitStatus: {
    maxFiles: 100,
    timeoutMs: 3000,
    maxUncompressedResultBytes: 128 * 1024
  },
  gitDiff: {
    maxBytes: 128 * 1024,
    timeoutMs: 3000,
    maxUncompressedResultBytes: 192 * 1024
  },
  context7: {
    maxQueryLength: 512,
    maxLibraryNameLength: 200,
    maxLibraryIdLength: 300,
    maxResults: 10,
    defaultMaxChars: 40_000,
    maxChars: 80_000,
    timeoutMs: 8000,
    maxUncompressedResultBytes: 128 * 1024
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
  "GIT_COMMAND_FAILED",
  "GIT_TIMEOUT",
  "CONTEXT7_NOT_CONFIGURED",
  "CONTEXT7_AUTH_FAILED",
  "CONTEXT7_RATE_LIMITED",
  "CONTEXT7_UPSTREAM_ERROR",
  "CONTEXT7_RESULT_TOO_LARGE",
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

export const describeWorkspaceChangesInputSchema = z.object({
  workspaceId: z.string(),
  includeUntracked: z.boolean().optional(),
  maxFiles: z.number().int().min(1).max(LIMITS.gitStatus.maxFiles).optional()
});

export const workspaceChangeStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "unmerged"
]);

export const describeWorkspaceChangesResultSchema = z.object({
  isGitRepository: z.boolean(),
  branch: z.string().optional(),
  head: z.string().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().optional(),
  behind: z.number().int().optional(),
  files: z.array(z.object({
    path: z.string(),
    status: workspaceChangeStatusSchema,
    staged: z.boolean(),
    unstaged: z.boolean(),
    oldPath: z.string().optional()
  })),
  truncated: z.boolean()
});

export const inspectWorkspaceDiffInputSchema = z.object({
  workspaceId: z.string(),
  path: z.string().optional(),
  staged: z.boolean().optional(),
  maxBytes: z.number().int().min(1).max(LIMITS.gitDiff.maxBytes).optional()
});

export const inspectWorkspaceDiffResultSchema = z.object({
  path: z.string().optional(),
  staged: z.boolean(),
  diff: z.string(),
  truncated: z.boolean()
});

export const context7ResolveLibraryIdInputSchema = z.object({
  libraryName: z.string().min(1).max(LIMITS.context7.maxLibraryNameLength),
  query: z.string().min(1).max(LIMITS.context7.maxQueryLength),
  maxResults: z.number().int().min(1).max(LIMITS.context7.maxResults).optional()
});

export const context7ResolveLibraryIdResultSchema = z.object({
  results: z.array(z.object({
    libraryId: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    totalSnippets: z.number().int().nonnegative().optional(),
    trustScore: z.number().optional(),
    tokens: z.number().int().nonnegative().optional()
  })),
  selected: z.object({
    libraryId: z.string(),
    reason: z.string().optional()
  }).optional(),
  truncated: z.boolean()
});

export const context7QueryDocsInputSchema = z.object({
  libraryId: z.string().min(1).max(LIMITS.context7.maxLibraryIdLength),
  query: z.string().min(1).max(LIMITS.context7.maxQueryLength),
  type: z.enum(["json", "txt"]).optional(),
  fast: z.boolean().optional(),
  maxChars: z.number().int().min(1).max(LIMITS.context7.maxChars).optional()
});

export const context7QueryDocsResultSchema = z.object({
  libraryId: z.string(),
  query: z.string(),
  type: z.enum(["json", "txt"]),
  content: z.string().optional(),
  codeSnippets: z.array(z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    language: z.string().optional(),
    code: z.string().optional(),
    source: z.string().optional()
  })).optional(),
  infoSnippets: z.array(z.object({
    title: z.string().optional(),
    breadcrumb: z.string().optional(),
    content: z.string(),
    source: z.string().optional()
  })).optional(),
  rules: z.unknown().optional(),
  truncated: z.boolean()
});

export const workspaceInputSchemas = {
  listWorkspaces: listWorkspacesInputSchema,
  createAgentPairingCode: createAgentPairingCodeInputSchema,
  describeWorkspace: describeWorkspaceInputSchema,
  listTree: listTreeInputSchema,
  inspectFile: inspectFileInputSchema,
  searchFile: searchFileInputSchema,
  batchExec: batchExecInputSchema,
  describeWorkspaceChanges: describeWorkspaceChangesInputSchema,
  inspectWorkspaceDiff: inspectWorkspaceDiffInputSchema
} as const;

export const workspaceResultSchemas = {
  listWorkspaces: listWorkspacesResultSchema,
  createAgentPairingCode: createAgentPairingCodeResultSchema,
  describeWorkspace: describeWorkspaceResultSchema,
  listTree: listTreeResultSchema,
  inspectFile: inspectFileResultSchema,
  searchFile: searchFileResultSchema,
  batchExec: batchExecResultSchema,
  describeWorkspaceChanges: describeWorkspaceChangesResultSchema,
  inspectWorkspaceDiff: inspectWorkspaceDiffResultSchema
} as const;

export const context7InputSchemas = {
  context7ResolveLibraryId: context7ResolveLibraryIdInputSchema,
  context7QueryDocs: context7QueryDocsInputSchema
} as const;

export const context7ResultSchemas = {
  context7ResolveLibraryId: context7ResolveLibraryIdResultSchema,
  context7QueryDocs: context7QueryDocsResultSchema
} as const;

export const actionInputSchemas = {
  ...workspaceInputSchemas,
  ...context7InputSchemas
} as const;

export const actionResultSchemas = {
  ...workspaceResultSchemas,
  ...context7ResultSchemas
} as const;

export const agentInputSchemas = {
  describeWorkspace: describeWorkspaceInputSchema,
  listTree: listTreeInputSchema,
  inspectFile: inspectFileInputSchema,
  searchFile: searchFileInputSchema,
  batchExec: batchExecInputSchema,
  describeWorkspaceChanges: describeWorkspaceChangesInputSchema,
  inspectWorkspaceDiff: inspectWorkspaceDiffInputSchema
} as const;

export const agentResultSchemas = {
  describeWorkspace: describeWorkspaceResultSchema,
  listTree: listTreeResultSchema,
  inspectFile: inspectFileResultSchema,
  searchFile: searchFileResultSchema,
  batchExec: batchExecResultSchema,
  describeWorkspaceChanges: describeWorkspaceChangesResultSchema,
  inspectWorkspaceDiff: inspectWorkspaceDiffResultSchema
} as const;

export const inputSchemas = actionInputSchemas;
export const resultSchemas = actionResultSchemas;

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

export const unpairAgentRequestSchema = z.object({
  agentId: z.string()
});

export type UnpairAgentRequest = z.infer<typeof unpairAgentRequestSchema>;

export const unpairAgentResponseSchema = z.object({
  ok: z.literal(true)
});

export type UnpairAgentResponse = z.infer<typeof unpairAgentResponseSchema>;

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
