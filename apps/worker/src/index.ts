import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { OAUTH_SCOPE, unpairAgentRequestSchema, unpairAgentResponseSchema } from "@workspace-viewer/protocol";
import type { OAuthProps } from "./auth.js";
import type { Env } from "./env.js";
import { handleMcp } from "./mcp.js";
import { handleAuthorize, handleGitHubCallback } from "./oauth.js";
import { completeAgentPairing } from "./pairing.js";
import { getAgent, revokeAgent, touchAgent } from "./repository.js";
import { verifyAgentToken } from "./crypto.js";
export { AgentSession } from "./session.js";

class McpApiHandler extends WorkerEntrypoint<Env, OAuthProps> {
  async fetch(request: Request): Promise<Response> {
    return handleMcp(request, this.env, this.ctx.props);
  }
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "workspace-viewer" });
    }

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    if (url.pathname === "/callback/github") {
      return handleGitHubCallback(request, env);
    }

    if (url.pathname === "/agent/connect") {
      return connectAgent(request, env);
    }

    if (url.pathname === "/agent/pair/complete") {
      return completeAgentPairing(request, env);
    }

    if (url.pathname === "/agent/unpair") {
      return unpairAgent(request, env);
    }

    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }

    return new Response("Not found", { status: 404 });
  }
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauthProvider(env, request).fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await oauthProvider(env).purgeExpiredData(env, { batchSize: 100 });
  }
};

function oauthProvider(env: Env, request?: Request): OAuthProvider<Env> {
  const baseUrl = publicBaseUrl(env, request);
  const mcpResourceUrl = `${baseUrl}/mcp`;
  return new OAuthProvider<Env>({
    authorizeEndpoint: `${baseUrl}/authorize`,
    tokenEndpoint: `${baseUrl}/token`,
    clientRegistrationEndpoint: `${baseUrl}/register`,
    apiRoute: "/mcp",
    apiHandler: McpApiHandler,
    defaultHandler,
    scopesSupported: [OAUTH_SCOPE],
    allowPlainPKCE: false,
    resourceMetadata: {
      resource: mcpResourceUrl,
      authorization_servers: [baseUrl],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Workspace Viewer"
    }
  });
}

function publicBaseUrl(env: Env, request?: Request): string {
  return (env.PUBLIC_BASE_URL ?? (request ? new URL(request.url).origin : "http://localhost:8787")).replace(/\/$/, "");
}

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

  const agent = await getAgent(env.DB, agentId);
  if (!agent || !(await verifyAgentToken(token, agent.token_hash))) {
    return new Response("Invalid agent credentials", { status: 403 });
  }
  await touchAgent(env.DB, agentId);

  const stub = env.AGENT_SESSION.getByName(agentId);
  return stub.fetch(request);
}

async function unpairAgent(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const input = unpairAgentRequestSchema.parse(await request.json());
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return new Response("agent token is required", { status: 401 });
  }

  const agent = await getAgent(env.DB, input.agentId);
  if (!agent || !(await verifyAgentToken(token, agent.token_hash))) {
    return new Response("Invalid agent credentials", { status: 403 });
  }

  await env.AGENT_SESSION.getByName(input.agentId).disconnect("Agent was unpaired");
  await revokeAgent(env.DB, input.agentId);
  return Response.json(unpairAgentResponseSchema.parse({ ok: true }));
}
