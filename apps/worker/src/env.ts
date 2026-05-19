import type { AgentSession } from "./session.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  AGENT_SESSION: DurableObjectNamespace<AgentSession>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  DEV_USER_ID?: string;
  DEV_AUTH_BYPASS_ENABLED?: string;
  PUBLIC_BASE_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OAUTH_COOKIE_SECRET?: string;
  OAUTH_BOOTSTRAP_DEV_WORKSPACE_ON_FIRST_LOGIN?: string;
  REVIEW_LOGIN_ENABLED?: string;
  REVIEW_EMAIL?: string;
  REVIEW_PASSWORD_HASH?: string;
  REVIEW_PROVIDER_SUBJECT?: string;
  OPENAI_APPS_CHALLENGE_TOKEN?: string;
  ENVIRONMENT?: string;
}
