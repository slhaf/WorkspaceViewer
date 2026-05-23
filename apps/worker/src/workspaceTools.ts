import {
  AGENT_TOOL_NAMES,
  LIMITS,
  type AgentToolName,
  type DispatchRequest,
  workspaceInputSchemas,
  workspaceResultSchemas,
  workspaceError
} from "@workspace-viewer/protocol";
import type { Env } from "./env.js";
import { gunzipJson } from "./gzip.js";
import {
  createPairingSession,
  getWorkspaceForUser,
  listWorkspacesForUser,
  parseLanguages
} from "./repository.js";

export async function callWorkspaceTool(
  env: Env,
  userId: string,
  name: string,
  args: unknown
): Promise<unknown> {
  if (name === "listWorkspaces") {
    const input = workspaceInputSchemas.listWorkspaces.parse(args);
    const rows = await listWorkspacesForUser(env.DB, userId);
    console.log("listWorkspaces DB result", {
      workspaceCount: rows.length
    });
    const uniqueAgentIds = [...new Set(rows.map((row) => row.agent_id))];
    console.log("listWorkspaces online probes", {
      agentCount: uniqueAgentIds.length
    });
    const onlineByAgent = new Map<string, boolean>();
    await Promise.all(uniqueAgentIds.map(async (agentId) => {
      try {
        onlineByAgent.set(agentId, await env.AGENT_SESSION.getByName(agentId).isOnline());
      } catch (error) {
        console.error("listWorkspaces online probe failed", {
          agentId,
          errorType: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
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

    return workspaceResultSchemas.listWorkspaces.parse({ workspaces });
  }

  if (name === "createAgentPairingCode") {
    const input = workspaceInputSchemas.createAgentPairingCode.parse(args);
    const pairingCode = await createUniquePairingCode(env.DB);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await createPairingSession(env.DB, pairingCode, userId, input.agentDisplayName, expiresAt);
    return workspaceResultSchemas.createAgentPairingCode.parse({
      pairingCode,
      expiresAt,
      commandHint: `workspace-viewer-agent pair ${pairingCode}`
    });
  }

  if (!isAgentToolName(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const schema = workspaceInputSchemas[name];
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
  const parsed = workspaceResultSchemas[name].parse(json);
  return parsed;
}

function isAgentToolName(value: string): value is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(value);
}

async function createUniquePairingCode(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = pairingCode();
    const existing = await db.prepare("SELECT code FROM pairing_sessions WHERE code = ?").bind(code).first();
    if (!existing) return code;
  }
  throw new Error("Unable to allocate pairing code");
}

function pairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function zObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
