import {
  LIMITS,
  type AgentToolName,
  type DispatchRequest,
  inputSchemas,
  resultSchemas,
  workspaceError
} from "@workspace-viewer/protocol";
import type { Env } from "./env.js";
import { resolveUser } from "./auth.js";
import { gunzipJson } from "./gzip.js";
import { getWorkspaceForUser, listWorkspacesForUser, parseLanguages } from "./repository.js";

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const toolDescriptions: Record<string, string> = {
  listWorkspaces: "Use this when you need to discover the user's registered local workspaces.",
  describeWorkspace: "Use this when you need a low-cost summary of a workspace.",
  listTree: "Use this when you need to inspect a workspace directory tree.",
  inspectFile: "Use this when you need to read a bounded range from a text file.",
  searchFile: "Use this when you need to search by path or file content inside a workspace.",
  batchExec: "Use this when you need to run several read-only workspace inspections in one call."
};

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return Response.json({
      name: "workspace-viewer",
      tools: Object.entries(toolDescriptions).map(([name, description]) => ({
        name,
        description,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      }))
    });
  }

  const auth = await resolveUser(env, request);
  if (auth instanceof Response) return auth;

  const rpc = await request.json<JsonRpcRequest>();
  if (rpc.method === "tools/list") {
    return rpcResult(rpc.id, {
      tools: Object.entries(toolDescriptions).map(([name, description]) => ({
        name,
        description,
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      }))
    });
  }

  if (rpc.method !== "tools/call") {
    return rpcError(rpc.id, -32601, "Method not found");
  }

  const params = zObject(rpc.params);
  const name = typeof params.name === "string" ? params.name : "";
  const args = params.arguments ?? {};
  try {
    const result = await callTool(env, auth.userId, name, args);
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

async function callTool(env: Env, userId: string, name: string, args: unknown): Promise<unknown> {
  if (name === "listWorkspaces") {
    const input = inputSchemas.listWorkspaces.parse(args);
    const rows = await listWorkspacesForUser(env.DB, userId);
    const uniqueAgentIds = [...new Set(rows.map((row) => row.agent_id))];
    const onlineByAgent = new Map<string, boolean>();
    await Promise.all(uniqueAgentIds.map(async (agentId) => {
      onlineByAgent.set(agentId, await env.AGENT_SESSION.getByName(agentId).isOnline());
    }));

    const workspaces = rows
      .map((row) => ({
        workspaceId: row.workspace_id,
        displayName: row.display_name,
        agentId: row.agent_id,
        agentDisplayName: row.agent_display_name ?? undefined,
        agentOnline: onlineByAgent.get(row.agent_id) ?? false,
        languages: parseLanguages(row.languages_json)
      }))
      .filter((workspace) => input.includeOffline || workspace.agentOnline);

    return resultSchemas.listWorkspaces.parse({ workspaces });
  }

  if (!isAgentToolName(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const schema = inputSchemas[name];
  const input = schema.parse(args);
  const workspaceId = zObject(input).workspaceId;
  if (typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }

  const workspace = await getWorkspaceForUser(env.DB, userId, workspaceId);
  if (!workspace) {
    return {
      ok: false,
      error: workspaceError("WORKSPACE_FORBIDDEN", "Workspace is not accessible by this user")
    };
  }

  const dispatch: DispatchRequest = {
    requestId: crypto.randomUUID(),
    userId,
    agentId: workspace.agent_id,
    workspaceId,
    tool: name,
    input,
    timeoutMs: name === "batchExec" ? LIMITS.batchExec.maxTotalTimeoutMs : LIMITS.relay.defaultTimeoutMs
  };
  const relay = await env.AGENT_SESSION.getByName(workspace.agent_id).dispatch(dispatch);
  if (!relay.ok) {
    return { ok: false, error: relay.error };
  }

  const json = await gunzipJson(relay.compressedPayload, relay.uncompressedBytes);
  const parsed = resultSchemas[name].parse(json);
  return parsed;
}

function isAgentToolName(value: string): value is AgentToolName {
  return ["describeWorkspace", "listTree", "inspectFile", "searchFile", "batchExec"].includes(value);
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
