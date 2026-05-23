import { describe, expect, it } from "vitest";
import { OAUTH_SCOPE } from "@workspace-viewer/protocol";
import { actionOpenApi, handleActionsApi } from "./actions.js";
import type { Env } from "./env.js";

describe("gpt actions", () => {
  it("serves an OpenAPI schema with OAuth and consequential metadata", async () => {
    const response = actionOpenApi(new Request("https://worker.example.com/actions/openapi.json"), {
      PUBLIC_BASE_URL: "https://workspace-viewer.example.com"
    } as Env);
    const json = await response.json<{
      openapi: string;
      servers: Array<{ url: string }>;
      components: { securitySchemes: { oauth: { flows: { authorizationCode: { scopes: Record<string, string> } } } } };
      paths: Record<string, { post: { operationId: string; "x-openai-isConsequential": boolean } }>;
    }>();

    expect(json.openapi).toBe("3.1.0");
    expect(JSON.stringify(json)).not.toContain("#/components/schemas/TreeEntry");
    expect(json.servers[0]?.url).toBe("https://workspace-viewer.example.com");
    expect(json.components.securitySchemes.oauth.flows.authorizationCode.scopes[OAUTH_SCOPE]).toBeTruthy();
    expect(json.paths["/actions/v1/create-agent-pairing-code"]?.post.operationId).toBe("createAgentPairingCode");
    expect(json.paths["/actions/v1/create-agent-pairing-code"]?.post["x-openai-isConsequential"]).toBe(true);
    expect(json.paths["/actions/v1/inspect-file"]?.post["x-openai-isConsequential"]).toBe(false);
    expect(json.paths["/actions/v1/describe-workspace-changes"]?.post.operationId).toBe("describeWorkspaceChanges");
    expect(json.paths["/actions/v1/describe-workspace-changes"]?.post["x-openai-isConsequential"]).toBe(false);
    expect(json.paths["/actions/v1/inspect-workspace-diff"]?.post.operationId).toBe("inspectWorkspaceDiff");
    expect(json.paths["/actions/v1/inspect-workspace-diff"]?.post["x-openai-isConsequential"]).toBe(false);
    expect(json.paths["/actions/v1/context7/resolve-library-id"]?.post.operationId).toBe("context7ResolveLibraryId");
    expect(json.paths["/actions/v1/context7/resolve-library-id"]?.post["x-openai-isConsequential"]).toBe(false);
    expect(json.paths["/actions/v1/context7/query-docs"]?.post.operationId).toBe("context7QueryDocs");
    expect(json.paths["/actions/v1/context7/query-docs"]?.post["x-openai-isConsequential"]).toBe(false);
  });

  it("rejects direct action calls without OAuth props", async () => {
    const response = await handleActionsApi(new Request("https://worker.example.com/actions/v1/list-workspaces", {
      method: "POST",
      body: "{}"
    }), {} as Env);
    const json = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(401);
    expect(json.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("returns plain JSON for createAgentPairingCode", async () => {
    const response = await handleActionsApi(new Request("https://worker.example.com/actions/v1/create-agent-pairing-code", {
      method: "POST",
      body: JSON.stringify({ agentDisplayName: "Laptop" })
    }), {
      DB: fakePairingDb()
    } as Env, { userId: "user_test" });
    const json = await response.json<{
      pairingCode: string;
      expiresAt: string;
      commandHint: string;
    }>();

    expect(response.status).toBe(200);
    expect(json.pairingCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(json.commandHint).toBe(`workspace-viewer-agent pair ${json.pairingCode}`);
  });

  it("returns structured Context7 configuration errors", async () => {
    const response = await handleActionsApi(new Request("https://worker.example.com/actions/v1/context7/query-docs", {
      method: "POST",
      body: JSON.stringify({ libraryId: "/facebook/react", query: "hooks" })
    }), {} as Env, { userId: "user_test" });
    const json = await response.json<{ error: { code: string; message: string } }>();

    expect(response.status).toBe(500);
    expect(json.error).toEqual({
      code: "CONTEXT7_NOT_CONFIGURED",
      message: "CONTEXT7_API_KEY is not configured"
    });
  });
});

function fakePairingDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("pairing_sessions")) return null;
              return { user_id: "user_test", status: "active" };
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
