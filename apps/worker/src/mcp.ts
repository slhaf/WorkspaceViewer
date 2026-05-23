import {
  LIMITS,
  OAUTH_SCOPE
} from "@workspace-viewer/protocol";
import type { Env } from "./env.js";
import { oauthChallenge, type OAuthProps, resolveUser } from "./auth.js";
import { callWorkspaceTool } from "./workspaceTools.js";

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

type JsonSchema = Record<string, unknown>;

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const toolDescriptions: Record<string, string> = {
  listWorkspaces: "Use this when you need to discover the user's registered local workspaces.",
  createAgentPairingCode: "Use this when the user needs to pair a local Workspace Viewer Agent.",
  describeWorkspace: "Use this when you need a low-cost summary of a workspace.",
  listTree: "Use this when you need to inspect a workspace directory tree.",
  inspectFile: "Use this when you need to read a bounded range from a text file.",
  searchFile: "Use this when you need to search by path or file content inside a workspace.",
  batchExec: "Use this when you need to run several read-only workspace inspections in one call.",
  describeWorkspaceChanges: "Use this when you need to summarize Git changes in a local workspace.",
  inspectWorkspaceDiff: "Use this when you need to read a bounded Git diff from a local workspace."
};

const toolInputSchemas: Record<string, JsonSchema> = {
  listWorkspaces: objectSchema({
    includeOffline: { type: "boolean" }
  }),
  createAgentPairingCode: objectSchema({
    agentDisplayName: { type: "string", minLength: 1, maxLength: 100 }
  }),
  describeWorkspace: objectSchema({
    workspaceId: { type: "string" }
  }, ["workspaceId"]),
  listTree: objectSchema({
    workspaceId: { type: "string" },
    path: { type: "string" },
    depth: { type: "integer", minimum: 0, maximum: LIMITS.listTree.maxDepth },
    includeFiles: { type: "boolean" }
  }, ["workspaceId"]),
  inspectFile: objectSchema({
    workspaceId: { type: "string" },
    path: { type: "string" },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 }
  }, ["workspaceId", "path"]),
  searchFile: objectSchema({
    workspaceId: { type: "string" },
    mode: { type: "string", enum: ["path", "content"] },
    query: { type: "string", minLength: 1, maxLength: LIMITS.searchFile.maxQueryLength },
    pathPrefix: { type: "string" },
    fileGlob: { type: "array", items: { type: "string" } },
    maxResults: { type: "integer", minimum: 1, maximum: LIMITS.searchFile.maxResults },
    contextLines: { type: "integer", minimum: 0, maximum: LIMITS.searchFile.maxContextLines }
  }, ["workspaceId", "mode", "query"]),
  batchExec: objectSchema({
    workspaceId: { type: "string" },
    operations: {
      type: "array",
      minItems: 1,
      maxItems: LIMITS.batchExec.maxOperations,
      items: {
        oneOf: [
          batchOperationSchema("describeWorkspace", objectSchema()),
          batchOperationSchema("listTree", objectSchema({
            path: { type: "string" },
            depth: { type: "integer", minimum: 0, maximum: LIMITS.listTree.maxDepth },
            includeFiles: { type: "boolean" }
          })),
          batchOperationSchema("inspectFile", objectSchema({
            path: { type: "string" },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 }
          }, ["path"])),
          batchOperationSchema("searchFile", objectSchema({
            mode: { type: "string", enum: ["path", "content"] },
            query: { type: "string", minLength: 1, maxLength: LIMITS.searchFile.maxQueryLength },
            pathPrefix: { type: "string" },
            fileGlob: { type: "array", items: { type: "string" } },
            maxResults: { type: "integer", minimum: 1, maximum: LIMITS.searchFile.maxResults },
            contextLines: { type: "integer", minimum: 0, maximum: LIMITS.searchFile.maxContextLines }
          }, ["mode", "query"])),
          batchOperationSchema("describeWorkspaceChanges", objectSchema({
            includeUntracked: { type: "boolean" },
            maxFiles: { type: "integer", minimum: 1, maximum: LIMITS.gitStatus.maxFiles }
          })),
          batchOperationSchema("inspectWorkspaceDiff", objectSchema({
            path: { type: "string" },
            staged: { type: "boolean" },
            maxBytes: { type: "integer", minimum: 1, maximum: LIMITS.gitDiff.maxBytes }
          }))
        ]
      }
    }
  }, ["workspaceId", "operations"]),
  describeWorkspaceChanges: objectSchema({
    workspaceId: { type: "string" },
    includeUntracked: { type: "boolean" },
    maxFiles: { type: "integer", minimum: 1, maximum: LIMITS.gitStatus.maxFiles }
  }, ["workspaceId"]),
  inspectWorkspaceDiff: objectSchema({
    workspaceId: { type: "string" },
    path: { type: "string" },
    staged: { type: "boolean" },
    maxBytes: { type: "integer", minimum: 1, maximum: LIMITS.gitDiff.maxBytes }
  }, ["workspaceId"])
};

const workspaceToolErrorOutputSchema = objectSchema({
  code: {
    type: "string",
    enum: [
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
      "INTERNAL_ERROR"
    ]
  },
  message: { type: "string" },
  details: { type: "object" }
}, ["code", "message"]);

const toolOutputSchemas: Record<string, JsonSchema> = {
  listWorkspaces: objectSchema({
    workspaces: {
      type: "array",
      items: objectSchema({
        workspaceId: { type: "string" },
        displayName: { type: "string" },
        agentId: { type: "string" },
        agentDisplayName: { type: "string" },
        agentOnline: { type: "boolean" },
        languages: { type: "array", items: { type: "string" } }
      }, ["workspaceId", "displayName", "agentId", "agentOnline"])
    }
  }, ["workspaces"]),
  createAgentPairingCode: objectSchema({
    pairingCode: { type: "string" },
    expiresAt: { type: "string" },
    commandHint: { type: "string" }
  }, ["pairingCode", "expiresAt", "commandHint"]),
  describeWorkspace: objectSchema({
    workspaceId: { type: "string" },
    displayName: { type: "string" },
    languages: { type: "array", items: { type: "string" } },
    rootEntries: {
      type: "array",
      items: objectSchema({
        name: { type: "string" },
        type: { type: "string", enum: ["file", "directory"] }
      }, ["name", "type"])
    },
    markers: { type: "array", items: { type: "string" } }
  }, ["workspaceId", "displayName", "rootEntries"]),
  listTree: {
    ...objectSchema({
      path: { type: "string" },
      depth: { type: "integer", minimum: 0 },
      entries: { type: "array", items: { $ref: "#/$defs/treeEntry" } },
      truncated: { type: "boolean" }
    }, ["path", "depth", "entries", "truncated"]),
    $defs: {
      treeEntry: objectSchema({
        name: { type: "string" },
        path: { type: "string" },
        type: { type: "string", enum: ["file", "directory"] },
        children: { type: "array", items: { $ref: "#/$defs/treeEntry" } }
      }, ["name", "path", "type"])
    }
  },
  inspectFile: objectSchema({
    path: { type: "string" },
    language: { type: "string" },
    sizeBytes: { type: "integer", minimum: 0 },
    totalLines: { type: "integer", minimum: 0 },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 0 },
    content: { type: "string" },
    truncated: { type: "boolean" }
  }, ["path", "sizeBytes", "totalLines", "startLine", "endLine", "content", "truncated"]),
  searchFile: {
    oneOf: [
      objectSchema({
        mode: { type: "string", const: "path" },
        query: { type: "string" },
        matches: {
          type: "array",
          items: objectSchema({
            path: { type: "string" },
            name: { type: "string" },
            type: { type: "string", enum: ["file", "directory"] }
          }, ["path", "name", "type"])
        },
        truncated: { type: "boolean" }
      }, ["mode", "query", "matches", "truncated"]),
      objectSchema({
        mode: { type: "string", const: "content" },
        query: { type: "string" },
        matches: {
          type: "array",
          items: objectSchema({
            path: { type: "string" },
            line: { type: "integer", minimum: 1 },
            preview: { type: "string" },
            before: { type: "array", items: { type: "string" } },
            after: { type: "array", items: { type: "string" } }
          }, ["path", "line", "preview"])
        },
        truncated: { type: "boolean" }
      }, ["mode", "query", "matches", "truncated"])
    ]
  },
  batchExec: objectSchema({
    results: {
      type: "array",
      items: objectSchema({
        id: { type: "string" },
        ok: { type: "boolean" },
        result: {},
        error: workspaceToolErrorOutputSchema
      }, ["id", "ok"])
    }
  }, ["results"]),
  describeWorkspaceChanges: objectSchema({
    isGitRepository: { type: "boolean" },
    branch: { type: "string" },
    head: { type: "string" },
    upstream: { type: "string" },
    ahead: { type: "integer" },
    behind: { type: "integer" },
    files: {
      type: "array",
      items: objectSchema({
        path: { type: "string" },
        status: { type: "string", enum: ["added", "modified", "deleted", "renamed", "copied", "untracked", "unmerged"] },
        staged: { type: "boolean" },
        unstaged: { type: "boolean" },
        oldPath: { type: "string" }
      }, ["path", "status", "staged", "unstaged"])
    },
    truncated: { type: "boolean" }
  }, ["isGitRepository", "files", "truncated"]),
  inspectWorkspaceDiff: objectSchema({
    path: { type: "string" },
    staged: { type: "boolean" },
    diff: { type: "string" },
    truncated: { type: "boolean" }
  }, ["staged", "diff", "truncated"])
};

export async function handleMcp(request: Request, env: Env, props?: OAuthProps): Promise<Response> {
  if (request.method === "GET") {
    return Response.json({
      name: "workspace-viewer",
      tools: Object.entries(toolDescriptions).map(([name, description]) => toolDescriptor(name, description))
    });
  }

  const rpc = await request.json<JsonRpcRequest>();
  const auth = await resolveUser(env, request, props);
  if (auth instanceof Response) return rpcAuthError(rpc.id, request, "Authentication required");

  if (rpc.method === "initialize") {
    return rpcResult(rpc.id, initializeResult(rpc.params));
  }

  if (rpc.method === "notifications/initialized") {
    return notificationAccepted();
  }

  if (rpc.method === "ping") {
    return rpcResult(rpc.id, {});
  }

  if (rpc.method === "tools/list") {
    return rpcResult(rpc.id, {
      tools: Object.entries(toolDescriptions).map(([name, description]) => toolDescriptor(name, description))
    });
  }

  if (rpc.method !== "tools/call") {
    return rpcError(rpc.id, -32601, "Method not found");
  }

  const params = zObject(rpc.params);
  const name = typeof params.name === "string" ? params.name : "";
  const args = params.arguments ?? {};
  try {
    const result = await callWorkspaceTool(env, auth.userId, name, args);
    return rpcResult(rpc.id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool failed";
    return rpcResult(rpc.id, {
      isError: true,
      content: [{ type: "text", text: message }]
    });
  }
}

function initializeResult(params: unknown): {
  protocolVersion: string;
  capabilities: { tools: Record<string, never> };
  serverInfo: { name: string; title: string; version: string };
} {
  const requestedVersion = zObject(params).protocolVersion;
  const protocolVersion = typeof requestedVersion === "string" && isSupportedProtocolVersion(requestedVersion)
    ? requestedVersion
    : DEFAULT_PROTOCOL_VERSION;

  return {
    protocolVersion,
    capabilities: {
      tools: {}
    },
    serverInfo: {
      name: "workspace-viewer",
      title: "Workspace Viewer",
      version: "0.1.0"
    }
  };
}

function toolDescriptor(name: string, description: string): {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  securitySchemes: Array<{ type: "oauth2"; scopes: string[] }>;
  annotations: { readOnlyHint: boolean; destructiveHint: false; openWorldHint: boolean };
} {
  return {
    name,
    description,
    inputSchema: toolInputSchemas[name] ?? objectSchema(),
    outputSchema: toolOutputSchemas[name] ?? objectSchema(),
    securitySchemes: securitySchemes(),
    annotations: toolAnnotations(name)
  };
}

function objectSchema(properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false
  };
}

function batchOperationSchema(tool: string, input: JsonSchema): JsonSchema {
  return objectSchema({
    id: { type: "string", minLength: 1 },
    tool: { type: "string", const: tool },
    input
  }, ["id", "tool", "input"]);
}

function isSupportedProtocolVersion(value: string): value is typeof SUPPORTED_PROTOCOL_VERSIONS[number] {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(value as typeof SUPPORTED_PROTOCOL_VERSIONS[number]);
}

function securitySchemes(): Array<{ type: "oauth2"; scopes: string[] }> {
  return [{ type: "oauth2", scopes: [OAUTH_SCOPE] }];
}

function toolAnnotations(name: string): { readOnlyHint: boolean; destructiveHint: false; openWorldHint: boolean } {
  return {
    readOnlyHint: name !== "createAgentPairingCode",
    destructiveHint: false,
    openWorldHint: false
  };
}

function zObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function notificationAccepted(): Response {
  return new Response(null, { status: 202 });
}

function rpcAuthError(id: JsonRpcRequest["id"], request: Request, description: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
    isError: true,
    content: [{ type: "text", text: description }],
    _meta: {
      "mcp/www_authenticate": [
        `${oauthChallenge(request)}, error="insufficient_scope", error_description="${description.replaceAll("\"", "'")}"`
      ]
    }
    }
  }, {
    status: 401,
    headers: {
      "WWW-Authenticate": oauthChallenge(request)
    }
  });
}
