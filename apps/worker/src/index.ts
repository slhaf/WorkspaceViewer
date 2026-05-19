import { oauthPlaceholder } from "./auth.js";
import type { Env } from "./env.js";
import { handleMcp } from "./mcp.js";
import { getAgentForToken, touchAgent } from "./repository.js";
export { AgentSession } from "./session.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "workspace-viewer" });
    }

    if (["/authorize", "/token", "/register", "/callback/github"].includes(url.pathname)) {
      return oauthPlaceholder(url.pathname);
    }

    if (url.pathname === "/agent/connect") {
      return connectAgent(request, env);
    }

    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }

    return new Response("Not found", { status: 404 });
  }
};

async function connectAgent(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId");
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    ?? url.searchParams.get("token");
  if (!agentId || !token) {
    return new Response("agentId and token are required", { status: 401 });
  }

  const agent = await getAgentForToken(env.DB, agentId, token);
  if (!agent) {
    return new Response("Invalid agent credentials", { status: 403 });
  }
  await touchAgent(env.DB, agentId);

  const stub = env.AGENT_SESSION.getByName(agentId);
  return stub.fetch(request);
}
