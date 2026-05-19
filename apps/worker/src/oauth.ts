import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { OAUTH_SCOPE } from "@workspace-viewer/protocol";
import type { Env } from "./env.js";
import { bootstrapDevWorkspaceForUser, getUser, upsertGitHubUser } from "./repository.js";
import { signValue, verifySignedValue } from "./crypto.js";

const STATE_TTL_SECONDS = 10 * 60;
const OAUTH_STATE_COOKIE = "__Host-WV_OAUTH_STATE";

interface StoredOAuthState {
  request: AuthRequest;
  createdAt: string;
}

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserResponse {
  id: number;
  login: string;
  email: string | null;
}

interface GitHubEmailResponse {
  email: string;
  primary: boolean;
  verified: boolean;
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  assertOAuthConfig(env);
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const state = crypto.randomUUID();
  const stored: StoredOAuthState = {
    request: oauthRequest,
    createdAt: new Date().toISOString()
  };
  await env.OAUTH_KV.put(oauthStateKey(state), JSON.stringify(stored), {
    expirationTtl: STATE_TTL_SECONDS
  });

  const redirect = new URL("https://github.com/login/oauth/authorize");
  redirect.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  redirect.searchParams.set("redirect_uri", callbackUrl(request, env));
  redirect.searchParams.set("scope", "read:user user:email");
  redirect.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      location: redirect.toString(),
      "set-cookie": `${OAUTH_STATE_COOKIE}=${await signValue(state, env.OAUTH_COOKIE_SECRET)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`
    }
  });
}

export async function handleGitHubCallback(request: Request, env: Env): Promise<Response> {
  assertOAuthConfig(env);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return new Response("Missing GitHub OAuth code or state", { status: 400 });
  }

  const signedCookie = readCookie(request, OAUTH_STATE_COOKIE);
  const cookieState = signedCookie ? await verifySignedValue(signedCookie, env.OAUTH_COOKIE_SECRET) : null;
  if (cookieState !== state) {
    return new Response("Invalid OAuth state", { status: 400 });
  }

  const storedRaw = await env.OAUTH_KV.get(oauthStateKey(state));
  await env.OAUTH_KV.delete(oauthStateKey(state));
  if (!storedRaw) {
    return new Response("OAuth state expired", { status: 400 });
  }
  const stored = JSON.parse(storedRaw) as StoredOAuthState;

  const accessToken = await exchangeGitHubCode(request, env, code);
  const githubUser = await fetchGitHubUser(accessToken);
  const email = githubUser.email ?? await fetchPrimaryGitHubEmail(accessToken);
  const user = await upsertGitHubUser(env.DB, {
    providerSubject: String(githubUser.id),
    loginName: githubUser.login,
    email
  });
  if (user.status !== "active") {
    return new Response("User is suspended", {
      status: 403,
      headers: clearStateCookie()
    });
  }

  const current = await getUser(env.DB, user.user_id);
  if (!current || current.status !== "active") {
    return new Response("User is suspended", {
      status: 403,
      headers: clearStateCookie()
    });
  }

  if (env.OAUTH_BOOTSTRAP_DEV_WORKSPACE_ON_FIRST_LOGIN === "true") {
    await bootstrapDevWorkspaceForUser(env.DB, user.user_id);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: stored.request,
    userId: user.user_id,
    metadata: { provider: "github", login: githubUser.login },
    scope: [OAUTH_SCOPE],
    props: { userId: user.user_id, githubLogin: githubUser.login }
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: redirectTo,
      ...clearStateCookie()
    }
  });
}

function assertOAuthConfig(env: Env): asserts env is Env & {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OAUTH_COOKIE_SECRET: string;
} {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.OAUTH_COOKIE_SECRET) {
    throw new Error("GitHub OAuth is not configured");
  }
}

async function exchangeGitHubCode(request: Request, env: Env, code: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "workspace-viewer"
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(request, env)
    })
  });
  const json = await response.json<GitHubTokenResponse>();
  if (!response.ok || !json.access_token) {
    throw new Error(json.error_description ?? json.error ?? "GitHub token exchange failed");
  }
  return json.access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUserResponse> {
  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders(accessToken)
  });
  if (!response.ok) throw new Error("GitHub user lookup failed");
  return response.json<GitHubUserResponse>();
}

async function fetchPrimaryGitHubEmail(accessToken: string): Promise<string | null> {
  const response = await fetch("https://api.github.com/user/emails", {
    headers: githubHeaders(accessToken)
  });
  if (!response.ok) return null;
  const emails = await response.json<GitHubEmailResponse[]>();
  return emails.find((email) => email.primary && email.verified)?.email ?? null;
}

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "workspace-viewer",
    "x-github-api-version": "2022-11-28"
  };
}

function callbackUrl(request: Request, env: Env): string {
  const base = env.PUBLIC_BASE_URL ?? new URL(request.url).origin;
  return `${base.replace(/\/$/, "")}/callback/github`;
}

function oauthStateKey(state: string): string {
  return `github_oauth_state:${state}`;
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=");
  }
  return null;
}

function clearStateCookie(): Record<string, string> {
  return {
    "set-cookie": `${OAUTH_STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`
  };
}
