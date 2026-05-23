import { LIMITS, OAUTH_SCOPE } from "@workspace-viewer/protocol";
import { ZodError } from "zod";
import type { OAuthProps } from "./auth.js";
import { callWorkspaceTool } from "./workspaceTools.js";
import type { Env } from "./env.js";

const ACTION_RESULT_MAX_CHARS = 90_000;

const routes: Record<string, string> = {
    "/actions/v1/create-agent-pairing-code": "createAgentPairingCode",
    "/actions/v1/list-workspaces": "listWorkspaces",
    "/actions/v1/describe-workspace": "describeWorkspace",
    "/actions/v1/list-tree": "listTree",
    "/actions/v1/inspect-file": "inspectFile",
    "/actions/v1/search-file": "searchFile",
    "/actions/v1/batch-exec": "batchExec"
};

export async function handleActionsApi(request: Request, env: Env, props?: OAuthProps): Promise<Response> {
    const url = new URL(request.url);
    const toolName = routes[url.pathname];
    if (!toolName) {
        return json({ error: { code: "NOT_FOUND", message: "Action endpoint not found" } }, 404);
    }
    if (request.method !== "POST") {
        return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use POST for this action" } }, 405);
    }

    const userId = typeof props?.userId === "string" ? props.userId : undefined;
    if (!userId) {
        return json({ error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" } }, 401);
    }

    console.log("Action start", {
        toolName,
        pathname: url.pathname,
        hasUserId: true
    });

    try {
        const input = await readJson(request);
        const result = await callWorkspaceTool(env, userId, toolName, input);
        const response = json(trimForActions(result));
        console.log("Action success", {
            toolName,
            status: response.status
        });
        return response;
    } catch (error) {
        console.error("Action failure", {
            toolName,
            errorType: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error)
        });
        if (error instanceof SyntaxError) {
            return json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } }, 400);
        }
        if (error instanceof ZodError) {
            return json({
                error: {
                    code: "INVALID_PARAMS",
                    message: "Request parameters did not match the action schema",
                    details: error.flatten()
                }
            }, 400);
        }
        const message = error instanceof Error ? error.message : "Action failed";
        return json({ error: { code: "ACTION_FAILED", message } }, 500);
    }
}

export function actionOpenApi(request: Request, env: Env): Response {
    const baseUrl = (env.PUBLIC_BASE_URL ?? new URL(request.url).origin).replace(/\/$/, "");
    return json({
        openapi: "3.1.0",
        info: {
            title: "Workspace Viewer GPT Actions",
            version: "0.1.0",
            description: "Inspect user-approved local workspaces through a read-only local Agent."
        },
        servers: [{ url: baseUrl }],
        components: {
            securitySchemes: {
                oauth: {
                    type: "oauth2",
                    flows: {
                        authorizationCode: {
                            authorizationUrl: `${baseUrl}/authorize`,
                            tokenUrl: `${baseUrl}/token`,
                            scopes: {
                                [OAUTH_SCOPE]: "Access user-approved local workspace metadata and file excerpts."
                            }
                        }
                    }
                }
            },
            schemas: actionSchemas()
        },
        security: [{ oauth: [OAUTH_SCOPE] }],
        paths: {
            "/actions/v1/create-agent-pairing-code": postOperation({
                operationId: "createAgentPairingCode",
                summary: "Create a temporary local Agent pairing code",
                requestSchema: "CreateAgentPairingCodeInput",
                responseSchema: "CreateAgentPairingCodeResult",
                consequential: true
            }),
            "/actions/v1/list-workspaces": postOperation({
                operationId: "listWorkspaces",
                summary: "List registered local workspaces",
                requestSchema: "ListWorkspacesInput",
                responseSchema: "ListWorkspacesResult",
                consequential: false
            }),
            "/actions/v1/describe-workspace": postOperation({
                operationId: "describeWorkspace",
                summary: "Describe a workspace root",
                requestSchema: "DescribeWorkspaceInput",
                responseSchema: "DescribeWorkspaceResult",
                consequential: false
            }),
            "/actions/v1/list-tree": postOperation({
                operationId: "listTree",
                summary: "List a bounded workspace directory tree",
                requestSchema: "ListTreeInput",
                responseSchema: "ListTreeResult",
                consequential: false
            }),
            "/actions/v1/inspect-file": postOperation({
                operationId: "inspectFile",
                summary: "Read a bounded excerpt from a text file",
                requestSchema: "InspectFileInput",
                responseSchema: "InspectFileResult",
                consequential: false
            }),
            "/actions/v1/search-file": postOperation({
                operationId: "searchFile",
                summary: "Search workspace paths or text file contents",
                requestSchema: "SearchFileInput",
                responseSchema: "SearchFileResult",
                consequential: false
            }),
            "/actions/v1/batch-exec": postOperation({
                operationId: "batchExec",
                summary: "Run several read-only workspace inspections",
                requestSchema: "BatchExecInput",
                responseSchema: "BatchExecResult",
                consequential: false
            })
        }
    });
}

async function readJson(request: Request): Promise<unknown> {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
}

function trimForActions(value: unknown): unknown {
    if (JSON.stringify(value).length <= ACTION_RESULT_MAX_CHARS) return value;
    const trimmed = trimStrings(value, 20_000);
    if (JSON.stringify(trimmed).length <= ACTION_RESULT_MAX_CHARS) {
        return {
            truncated: true,
            result: trimmed,
            warning: "Long string fields were truncated to stay within GPT Actions payload limits."
        };
    }
    return {
        truncated: true,
        warning: "Action result was too large and was omitted to stay within GPT Actions payload limits."
    };
}

function trimStrings(value: unknown, maxStringLength: number): unknown {
    if (typeof value === "string") {
        return value.length > maxStringLength
            ? `${value.slice(0, maxStringLength)}\n[truncated]`
            : value;
    }
    if (Array.isArray(value)) return value.map((item) => trimStrings(item, maxStringLength));
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, trimStrings(item, maxStringLength)])
        );
    }
    return value;
}

function json(body: unknown, status = 200): Response {
    return Response.json(body, {
        status,
        headers: {
            "cache-control": "no-store"
        }
    });
}

function postOperation(options: {
    operationId: string;
    summary: string;
    requestSchema: string;
    responseSchema: string;
    consequential: boolean;
}): Record<string, unknown> {
    return {
        post: {
            operationId: options.operationId,
            summary: options.summary,
            "x-openai-isConsequential": options.consequential,
            security: [{ oauth: [OAUTH_SCOPE] }],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: { $ref: `#/components/schemas/${options.requestSchema}` }
                    }
                }
            },
            responses: {
                "200": {
                    description: "Successful action response",
                    content: {
                        "application/json": {
                            schema: { $ref: `#/components/schemas/${options.responseSchema}` }
                        }
                    }
                },
                "400": { description: "Invalid request parameters" },
                "401": { description: "Authentication required" },
                "403": { description: "Workspace is not accessible" },
                "500": { description: "Action failed" }
            }
        }
    };
}

function objectSchema(properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
    return {
        type: "object",
        properties,
        required,
        additionalProperties: false
    };
}

function actionSchemas(): Record<string, unknown> {
    const workspaceId = { type: "string", description: "Workspace ID returned by listWorkspaces." };
    return {
        CreateAgentPairingCodeInput: objectSchema({
            agentDisplayName: { type: "string", minLength: 1, maxLength: 100 }
        }),
        CreateAgentPairingCodeResult: objectSchema({
            pairingCode: { type: "string" },
            expiresAt: { type: "string", format: "date-time" },
            commandHint: { type: "string" }
        }, ["pairingCode", "expiresAt", "commandHint"]),
        ListWorkspacesInput: objectSchema({
            includeOffline: { type: "boolean" }
        }),
        ListWorkspacesResult: objectSchema({
            workspaces: {
                type: "array",
                items: objectSchema({
                    workspaceId: { type: "string" },
                    displayName: { type: "string" },
                    agentId: { type: "string" },
                    agentDisplayName: { type: "string" },
                    agentOnline: { type: "boolean" },
                    languages: { type: "array", items: { type: "string" } }
                }, ["workspaceId", "displayName", "agentId", "agentOnline"])
            }
        }, ["workspaces"]),
        DescribeWorkspaceInput: objectSchema({ workspaceId }, ["workspaceId"]),
        DescribeWorkspaceResult: objectSchema({
            workspaceId: { type: "string" },
            displayName: { type: "string" },
            languages: { type: "array", items: { type: "string" } },
            rootEntries: {
                type: "array",
                items: objectSchema({
                    name: { type: "string" },
                    type: { type: "string", enum: ["file", "directory"] }
                }, ["name", "type"])
            },
            markers: { type: "array", items: { type: "string" } }
        }, ["workspaceId", "displayName", "rootEntries"]),
        ListTreeInput: objectSchema({
            workspaceId,
            path: { type: "string" },
            depth: { type: "integer", minimum: 0, maximum: LIMITS.listTree.maxDepth },
            includeFiles: { type: "boolean" }
        }, ["workspaceId"]),
        ListTreeResult: objectSchema({
            path: { type: "string" },
            depth: { type: "integer", minimum: 0 },
            entries: {
                type: "array",
                items: objectSchema({
                    name: { type: "string" },
                    path: { type: "string" },
                    type: { type: "string", enum: ["file", "directory"] },
                    children: {
                        type: "array",
                        items: { type: "object", additionalProperties: true }
                    }
                }, ["name", "path", "type"])
            },
            truncated: { type: "boolean" }
        }, ["path", "depth", "entries", "truncated"]),
        InspectFileInput: objectSchema({
            workspaceId,
            path: { type: "string" },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 }
        }, ["workspaceId", "path"]),
        InspectFileResult: objectSchema({
            path: { type: "string" },
            language: { type: "string" },
            sizeBytes: { type: "integer", minimum: 0 },
            totalLines: { type: "integer", minimum: 0 },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 0 },
            content: { type: "string" },
            truncated: { type: "boolean" }
        }, ["path", "sizeBytes", "totalLines", "startLine", "endLine", "content", "truncated"]),
        SearchFileInput: objectSchema({
            workspaceId,
            mode: { type: "string", enum: ["path", "content"] },
            query: { type: "string", minLength: 1, maxLength: LIMITS.searchFile.maxQueryLength },
            pathPrefix: { type: "string" },
            fileGlob: { type: "array", items: { type: "string" } },
            maxResults: { type: "integer", minimum: 1, maximum: LIMITS.searchFile.maxResults },
            contextLines: { type: "integer", minimum: 0, maximum: LIMITS.searchFile.maxContextLines }
        }, ["workspaceId", "mode", "query"]),
        SearchFileResult: objectSchema({
            mode: { type: "string", enum: ["path", "content"] },
            query: { type: "string" },
            matches: {
                type: "array",
                items: objectSchema({
                    path: { type: "string" },
                    name: { type: "string" },
                    type: { type: "string", enum: ["file", "directory"] },
                    line: { type: "integer", minimum: 1 },
                    preview: { type: "string" },
                    before: { type: "array", items: { type: "string" } },
                    after: { type: "array", items: { type: "string" } }
                }, ["path"])
            },
            truncated: { type: "boolean" }
        }, ["mode", "query", "matches", "truncated"]),
        BatchExecInput: objectSchema({
            workspaceId,
            operations: {
                type: "array",
                minItems: 1,
                maxItems: LIMITS.batchExec.maxOperations,
                items: { type: "object", additionalProperties: true }
            }
        }, ["workspaceId", "operations"]),
        BatchExecResult: objectSchema({
            results: {
                type: "array",
                items: objectSchema({
                    id: { type: "string" },
                    ok: { type: "boolean" },
                    result: {},
                    error: { type: "object", additionalProperties: true }
                }, ["id", "ok"])
            }
        }, ["results"])
    };
}
