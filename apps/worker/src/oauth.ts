import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { OAUTH_SCOPE } from "@workspace-viewer/protocol";
import type { Env } from "./env.js";
import { bootstrapDevWorkspaceForUser, getUser, upsertGitHubUser, upsertReviewerUser } from "./repository.js";
import { signValue, verifyPasswordHash, verifySignedValue } from "./crypto.js";

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
  await ensureActionOAuthClient(env);
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const state = crypto.randomUUID();
  const stored: StoredOAuthState = {
    request: oauthRequest,
    createdAt: new Date().toISOString()
  };
  await env.OAUTH_KV.put(oauthStateKey(state), JSON.stringify(stored), {
    expirationTtl: STATE_TTL_SECONDS
  });

  return new Response(renderLoginPage(request, env, state), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": `${OAUTH_STATE_COOKIE}=${await signValue(state, env.OAUTH_COOKIE_SECRET)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`
    }
  });
}

export async function handleGitHubLogin(request: Request, env: Env): Promise<Response> {
  assertOAuthConfig(env);
  const state = new URL(request.url).searchParams.get("state");
  if (!state) {
    return new Response("Missing OAuth state", { status: 400 });
  }

  const storedRaw = await loadStoredOAuthState(request, env, state);
  if (storedRaw instanceof Response) return storedRaw;

  const redirect = new URL("https://github.com/login/oauth/authorize");
  redirect.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  redirect.searchParams.set("redirect_uri", callbackUrl(request, env));
  redirect.searchParams.set("scope", "read:user user:email");
  redirect.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      location: redirect.toString()
    }
  });
}

export async function handleReviewerLogin(request: Request, env: Env): Promise<Response> {
  assertOAuthConfig(env);
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (env.REVIEW_LOGIN_ENABLED !== "true") {
    return new Response("Reviewer login is disabled", { status: 404 });
  }
  if (!env.REVIEW_EMAIL || !env.REVIEW_PASSWORD_HASH) {
    return new Response("Reviewer login is not configured", { status: 500 });
  }

  const form = await request.formData();
  const email = form.get("email");
  const password = form.get("password");
  const state = form.get("state");
  if (typeof email !== "string" || typeof password !== "string" || typeof state !== "string" || !state) {
    return new Response("Missing reviewer credentials or state", { status: 400 });
  }

  const storedRaw = await loadStoredOAuthState(request, env, state);
  if (storedRaw instanceof Response) return storedRaw;

  const configuredEmail = env.REVIEW_EMAIL.trim().toLowerCase();
  const submittedEmail = email.trim().toLowerCase();
  if (submittedEmail !== configuredEmail || !(await verifyPasswordHash(password, env.REVIEW_PASSWORD_HASH))) {
    return new Response("Invalid reviewer credentials", { status: 401 });
  }

  const stored = JSON.parse(storedRaw) as StoredOAuthState;
  const providerSubject = env.REVIEW_PROVIDER_SUBJECT ?? "openai-review";
  const user = await upsertReviewerUser(env.DB, {
    providerSubject,
    email: env.REVIEW_EMAIL
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

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: stored.request,
    userId: user.user_id,
    metadata: { provider: "reviewer", login: "openai-review" },
    scope: [OAUTH_SCOPE],
    props: { userId: user.user_id }
  });

  await env.OAUTH_KV.delete(oauthStateKey(state));
  return new Response(null, {
    status: 302,
    headers: {
      location: redirectTo,
      ...clearStateCookie()
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

async function ensureActionOAuthClient(env: Env): Promise<void> {
  if (!env.ACTION_OAUTH_CLIENT_ID || !env.ACTION_OAUTH_REDIRECT_URIS) return;

  const redirectUris = env.ACTION_OAUTH_REDIRECT_URIS
    .split(",")
    .map((uri) => uri.trim())
    .filter(Boolean);
  if (redirectUris.length === 0) return;

  const clientInfo = {
    clientId: env.ACTION_OAUTH_CLIENT_ID,
    ...(env.ACTION_OAUTH_CLIENT_SECRET
      ? { clientSecret: await sha256Hex(env.ACTION_OAUTH_CLIENT_SECRET) }
      : {}),
    redirectUris,
    clientName: "Workspace Viewer GPT Action",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    registrationDate: Math.floor(Date.now() / 1000),
    tokenEndpointAuthMethod: env.ACTION_OAUTH_CLIENT_SECRET ? "client_secret_basic" : "none"
  };

  await env.OAUTH_KV.put(`client:${env.ACTION_OAUTH_CLIENT_ID}`, JSON.stringify(clientInfo));
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function loadStoredOAuthState(request: Request, env: Env, state: string): Promise<string | Response> {
  const signedCookie = readCookie(request, OAUTH_STATE_COOKIE);
  const cookieState = signedCookie ? await verifySignedValue(signedCookie, env.OAUTH_COOKIE_SECRET ?? "") : null;
  if (cookieState !== state) {
    return new Response("Invalid OAuth state", { status: 400 });
  }

  const storedRaw = await env.OAUTH_KV.get(oauthStateKey(state));
  if (!storedRaw) {
    return new Response("OAuth state expired", { status: 400 });
  }
  return storedRaw;
}

function oauthStateKey(state: string): string {
  return `github_oauth_state:${state}`;
}

function renderLoginPage(request: Request, env: Env, state: string): string {
  const githubUrl = new URL("/login/github", new URL(request.url).origin);
  githubUrl.searchParams.set("state", state);
  const reviewerEnabled = env.REVIEW_LOGIN_ENABLED === "true";
  const reviewerForm = reviewerEnabled
    ? `<section>
        <h2>Reviewer sign in</h2>
        <form method="post" action="/login/reviewer">
          <input type="hidden" name="state" value="${escapeHtml(state)}">
          <label>
            Email
            <input name="email" type="email" autocomplete="username" required>
          </label>
          <label>
            Password
            <input name="password" type="password" autocomplete="current-password" required>
          </label>
          <button type="submit">Sign in</button>
        </form>
      </section>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Workspace Viewer Sign In</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f6f7f9; }
    main { box-sizing: border-box; width: min(420px, calc(100vw - 32px)); margin: 72px auto; padding: 28px; background: #fff; border: 1px solid #dde2ea; border-radius: 8px; box-shadow: 0 10px 30px rgba(23, 32, 51, 0.08); }
    h1 { margin: 0; font-size: 26px; line-height: 1.2; }
    p { margin: 8px 0 24px; color: #536173; }
    section { border-top: 1px solid #e6e9ee; padding-top: 20px; margin-top: 20px; }
    section:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    a, button { box-sizing: border-box; display: block; width: 100%; border-radius: 6px; border: 1px solid #172033; background: #172033; color: #fff; padding: 10px 14px; font: inherit; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
    label { display: block; margin: 12px 0; color: #334155; font-size: 14px; font-weight: 600; }
    input { box-sizing: border-box; display: block; width: 100%; margin-top: 6px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px 12px; font: inherit; }
  </style>
</head>
<body>
  <main>
    <h1>Workspace Viewer</h1>
    <p>Sign in to continue</p>
    <section>
      <h2>Continue with GitHub</h2>
      <a href="${escapeHtml(githubUrl.pathname + githubUrl.search)}">Continue with GitHub</a>
    </section>
    ${reviewerForm}
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
