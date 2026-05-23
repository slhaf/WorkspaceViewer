import { describe, expect, it } from "vitest";
import { OAUTH_SCOPE } from "@workspace-viewer/protocol";
import type { Env } from "./env.js";
import { handleMcp } from "./mcp.js";

describe("mcp metadata", () => {
  it("declares OAuth security schemes for every tool", async () => {
    const response = await handleMcp(new Request("https://worker.example.com/mcp"), {} as Env);
    const json = await response.json<{
      tools: Array<{
        name: string;
        securitySchemes: Array<{ type: string; scopes: string[] }>;
        annotations: { readOnlyHint: boolean };
      }>;
    }>();

    expect(json.tools.length).toBeGreaterThan(0);
    for (const tool of json.tools) {
      expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: [OAUTH_SCOPE] }]);
    }
    expect(json.tools.find((tool) => tool.name === "createAgentPairingCode")?.annotations.readOnlyHint).toBe(false);
    expect(json.tools.find((tool) => tool.name === "inspectFile")?.annotations.readOnlyHint).toBe(true);
    expect(json.tools.find((tool) => tool.name === "describeWorkspaceChanges")?.annotations.readOnlyHint).toBe(true);
    expect(json.tools.find((tool) => tool.name === "inspectWorkspaceDiff")?.annotations.readOnlyHint).toBe(true);
    expect(json.tools.some((tool) => tool.name.startsWith("context7"))).toBe(false);
  });

  it("returns an OAuth challenge for unauthenticated tool calls", async () => {
    const response = await handleMcp(new Request("https://worker.example.com/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "listWorkspaces", arguments: {} }
      })
    }), {} as Env);
    const json = await response.json<{
      result: { _meta: { "mcp/www_authenticate": string[] } };
    }>();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(OAUTH_SCOPE);
    expect(json.result._meta["mcp/www_authenticate"][0]).toContain(OAUTH_SCOPE);
  });

  it("returns the pair command in pairing hints", async () => {
    const response = await handleMcp(new Request("https://worker.example.com/mcp", {
      method: "POST",
      headers: { "x-workspace-viewer-user": "user_test" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "createAgentPairingCode", arguments: {} }
      })
    }), {
      DEV_AUTH_BYPASS_ENABLED: "true",
      DB: fakePairingDb()
    } as Env);
    const json = await response.json<{
      result: { structuredContent: { commandHint: string } };
    }>();

    expect(json.result.structuredContent.commandHint).toMatch(/^workspace-viewer-agent pair /);
    expect(json.result.structuredContent.commandHint).not.toContain("--server");
  });
});

function fakePairingDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM users")) {
                return { user_id: "user_test", status: "active" };
              }
              return null;
            },
            async run() {
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  } as unknown as D1Database;
}
