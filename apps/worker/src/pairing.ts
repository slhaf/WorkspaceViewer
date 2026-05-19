import {
  completeAgentPairingRequestSchema,
  completeAgentPairingResponseSchema
} from "@workspace-viewer/protocol";
import type { Env } from "./env.js";
import { hashAgentToken, randomUrlSafe } from "./crypto.js";
import {
  createAgent,
  getPairingSession,
  markPairingSessionUsed,
  replaceAgentWorkspaces
} from "./repository.js";

export async function completeAgentPairing(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const input = completeAgentPairingRequestSchema.parse(await request.json());
  const code = input.pairingCode.trim().toUpperCase();
  const session = await getPairingSession(env.DB, code);
  const now = new Date().toISOString();
  if (!session) {
    return Response.json({ error: "invalid_pairing_code" }, { status: 404 });
  }
  if (session.used_at) {
    return Response.json({ error: "pairing_code_used" }, { status: 409 });
  }
  if (session.expires_at <= now) {
    return Response.json({ error: "pairing_code_expired" }, { status: 410 });
  }

  const marked = await markPairingSessionUsed(env.DB, code, now);
  if (!marked) {
    return Response.json({ error: "pairing_code_unavailable" }, { status: 409 });
  }

  const agentId = `agent_${crypto.randomUUID()}`;
  const agentToken = `wvagt_${randomUrlSafe(32)}`;
  const displayName = input.agentDisplayName ?? session.agent_display_name ?? "Local Agent";
  await createAgent(env.DB, agentId, session.user_id, displayName, await hashAgentToken(agentToken));
  if (input.workspaces) {
    await replaceAgentWorkspaces(env.DB, agentId, session.user_id, input.workspaces);
  }

  return Response.json(completeAgentPairingResponseSchema.parse({
    agentId,
    agentToken,
    serverBaseUrl: publicBaseUrl(request, env)
  }));
}

function publicBaseUrl(request: Request, env: Env): string {
  return (env.PUBLIC_BASE_URL ?? new URL(request.url).origin).replace(/\/$/, "");
}
