import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import { handleMcp } from "./mcp.js";
import { handleAuthorize, handleGitHubLogin, handleReviewerLogin } from "./oauth.js";
import { signValue } from "./crypto.js";

const cookieSecret = "test-cookie-secret";

describe("oauth login", () => {
  it("renders the login choice page with GitHub and reviewer form when enabled", async () => {
    const env = fakeEnv({ REVIEW_LOGIN_ENABLED: "true" });

    const response = await handleAuthorize(new Request("https://worker.example.com/authorize"), env);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("set-cookie")).toContain("__Host-WV_OAUTH_STATE=");
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain('action="/login/reviewer"');
    expect(html).toContain('name="state"');
  });

  it("seeds a static GPT Action OAuth client before parsing authorization requests", async () => {
    const env = fakeEnv({
      ACTION_OAUTH_CLIENT_ID: "gpt-action-client",
      ACTION_OAUTH_CLIENT_SECRET: "client-secret",
      ACTION_OAUTH_REDIRECT_URIS: "https://chatgpt.com/aip/g-test/oauth/callback"
    });

    const response = await handleAuthorize(new Request("https://worker.example.com/authorize"), env);
    const stored = await env.OAUTH_KV.get("client:gpt-action-client");
    const client = JSON.parse(stored ?? "{}") as {
      clientId?: string;
      clientSecret?: string;
      redirectUris?: string[];
      tokenEndpointAuthMethod?: string;
    };

    expect(response.status).toBe(200);
    expect(client.clientId).toBe("gpt-action-client");
    expect(client.clientSecret).not.toBe("client-secret");
    expect(client.redirectUris).toEqual(["https://chatgpt.com/aip/g-test/oauth/callback"]);
    expect(client.tokenEndpointAuthMethod).toBe("client_secret_basic");
  });

  it("omits the reviewer form when reviewer login is disabled", async () => {
    const env = fakeEnv({ REVIEW_LOGIN_ENABLED: "false" });

    const response = await handleAuthorize(new Request("https://worker.example.com/authorize"), env);
    const html = await response.text();

    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain('action="/login/reviewer"');
  });

  it("redirects GitHub login without consuming OAuth state", async () => {
    const env = fakeEnv();
    await env.OAUTH_KV.put("github_oauth_state:state_test", JSON.stringify({ request: { clientId: "client" } }));
    const request = new Request("https://worker.example.com/login/github?state=state_test", {
      headers: { cookie: await stateCookie("state_test") }
    });

    const response = await handleGitHubLogin(request, env);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    expect(response.headers.get("location")).toContain("state=state_test");
    expect(await env.OAUTH_KV.get("github_oauth_state:state_test")).not.toBeNull();
  });

  it("completes reviewer authorization with valid credentials", async () => {
    const env = fakeEnv({ REVIEW_LOGIN_ENABLED: "true" });
    await env.OAUTH_KV.put("github_oauth_state:state_test", JSON.stringify({ request: { clientId: "client" } }));

    const response = await handleReviewerLogin(await reviewerRequest("state_test", "review@example.com", "secret"), env);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://chatgpt.example.com/callback");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await env.OAUTH_KV.get("github_oauth_state:state_test")).toBeNull();
    const userId = env.dbState.users[0]?.user_id;
    expect(userId).toMatch(/^user_/);
    expect(env.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      metadata: { provider: "reviewer", login: "openai-review" },
      props: { userId }
    }));
  });

  it("keeps OAuth state when reviewer password is invalid", async () => {
    const env = fakeEnv({ REVIEW_LOGIN_ENABLED: "true" });
    await env.OAUTH_KV.put("github_oauth_state:state_test", JSON.stringify({ request: { clientId: "client" } }));

    const response = await handleReviewerLogin(await reviewerRequest("state_test", "review@example.com", "wrong"), env);

    expect(response.status).toBe(401);
    expect(await env.OAUTH_KV.get("github_oauth_state:state_test")).not.toBeNull();
    expect(env.completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects reviewer login when state cookie does not match", async () => {
    const env = fakeEnv({ REVIEW_LOGIN_ENABLED: "true" });
    await env.OAUTH_KV.put("github_oauth_state:state_test", JSON.stringify({ request: { clientId: "client" } }));

    const response = await handleReviewerLogin(await reviewerRequest("state_test", "review@example.com", "secret", "other"), env);

    expect(response.status).toBe(400);
    expect(await env.OAUTH_KV.get("github_oauth_state:state_test")).not.toBeNull();
    expect(env.completeAuthorization).not.toHaveBeenCalled();
  });

  it("reuses the reviewer user across repeated logins", async () => {
    const env = fakeEnv({ REVIEW_LOGIN_ENABLED: "true" });
    await env.OAUTH_KV.put("github_oauth_state:state_one", JSON.stringify({ request: { clientId: "client" } }));
    await env.OAUTH_KV.put("github_oauth_state:state_two", JSON.stringify({ request: { clientId: "client" } }));

    await handleReviewerLogin(await reviewerRequest("state_one", "review@example.com", "secret"), env);
    await handleReviewerLogin(await reviewerRequest("state_two", "review@example.com", "secret"), env);

    expect(env.dbState.users).toHaveLength(1);
    const userId = env.dbState.users[0]?.user_id;
    expect(env.completeAuthorization).toHaveBeenNthCalledWith(1, expect.objectContaining({ userId }));
    expect(env.completeAuthorization).toHaveBeenNthCalledWith(2, expect.objectContaining({ userId }));
  });

  it("rejects a suspended reviewer user", async () => {
    const env = fakeEnv({ REVIEW_LOGIN_ENABLED: "true" });
    env.dbState.users.push({
      user_id: "user_reviewer",
      auth_provider: "reviewer",
      provider_subject: "openai-review",
      login_name: "openai-review",
      email: "review@example.com",
      status: "suspended"
    });
    await env.OAUTH_KV.put("github_oauth_state:state_test", JSON.stringify({ request: { clientId: "client" } }));

    const response = await handleReviewerLogin(await reviewerRequest("state_test", "review@example.com", "secret"), env);

    expect(response.status).toBe(403);
    expect(env.completeAuthorization).not.toHaveBeenCalled();
  });
});

describe("reviewer OAuth props", () => {
  it("can be resolved by MCP without reviewer-specific handling", async () => {
    const env = fakeEnv();
    env.dbState.users.push({
      user_id: "user_reviewer",
      auth_provider: "reviewer",
      provider_subject: "openai-review",
      login_name: "openai-review",
      email: "review@example.com",
      status: "active"
    });

    const response = await handleMcp(new Request("https://worker.example.com/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "listWorkspaces", arguments: {} }
      })
    }), env, { userId: "user_reviewer" });

    expect(response.status).toBe(200);
  });
});

async function reviewerRequest(
  state: string,
  email: string,
  password: string,
  cookieState = state
): Promise<Request> {
  const body = new URLSearchParams({ state, email, password });
  return new Request("https://worker.example.com/login/reviewer", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: await stateCookie(cookieState)
    },
    body
  });
}

async function stateCookie(state: string): Promise<string> {
  return `__Host-WV_OAUTH_STATE=${await signValue(state, cookieSecret)}`;
}

function fakeEnv(overrides: Partial<Env> = {}): Env & {
  completeAuthorization: ReturnType<typeof vi.fn>;
  dbState: FakeDbState;
} {
  const kv = new Map<string, string>();
  const dbState: FakeDbState = { users: [] };
  const completeAuthorization = vi.fn(async () => ({ redirectTo: "https://chatgpt.example.com/callback" }));
  const env = {
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    OAUTH_COOKIE_SECRET: cookieSecret,
    REVIEW_EMAIL: "review@example.com",
    REVIEW_PASSWORD_HASH: "sha256:2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b",
    REVIEW_PROVIDER_SUBJECT: "openai-review",
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn(async () => ({ clientId: "client" })),
      completeAuthorization
    },
    OAUTH_KV: {
      async put(key: string, value: string) {
        kv.set(key, value);
      },
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async delete(key: string) {
        kv.delete(key);
      }
    },
    DB: fakeDb(dbState),
    completeAuthorization,
    dbState,
    ...overrides
  } as Env & {
    completeAuthorization: ReturnType<typeof vi.fn>;
    dbState: FakeDbState;
  };
  return env;
}

interface FakeUser {
  user_id: string;
  auth_provider: string;
  provider_subject: string;
  login_name: string | null;
  email: string | null;
  status: "active" | "suspended";
}

interface FakeDbState {
  users: FakeUser[];
}

function fakeDb(state: FakeDbState): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first() {
              if (sql.includes("WHERE auth_provider = 'reviewer'")) {
                const providerSubject = String(params[0]);
                return state.users.find((user) =>
                  user.auth_provider === "reviewer" && user.provider_subject === providerSubject
                ) ?? null;
              }
              if (sql.includes("FROM users WHERE user_id = ?")) {
                const userId = String(params[0]);
                const user = state.users.find((item) => item.user_id === userId);
                return user ? { user_id: user.user_id, status: user.status } : null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes("UPDATE users")) {
                const loginName = String(params[0]);
                const email = String(params[1]);
                const userId = String(params[2]);
                const user = state.users.find((item) => item.user_id === userId);
                if (user) {
                  user.login_name = loginName;
                  user.email = email;
                }
              }
              if (sql.includes("INSERT INTO users") && sql.includes("'reviewer'")) {
                state.users.push({
                  user_id: String(params[0]),
                  auth_provider: "reviewer",
                  provider_subject: String(params[1]),
                  login_name: "openai-review",
                  email: String(params[2]),
                  status: "active"
                });
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  } as unknown as D1Database;
}
