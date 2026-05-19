# Workspace Viewer

Workspace Viewer is a read-only local workspace access layer for ChatGPT Apps-style MCP tool calls.

## Packages

- `packages/protocol`: shared schemas, protocol types, errors, and limits.
- `apps/worker`: Cloudflare Worker, D1 access, Durable Object relay, and `/mcp` JSON-RPC endpoint.
- `apps/agent`: local Node.js Agent that reads configured workspaces and returns gzip-compressed tool results over WebSocket.

## Local Development

```bash
pnpm install
pnpm build
```

Apply D1 migrations for the Worker:

```bash
cd apps/worker
pnpm wrangler d1 migrations apply workspace-viewer-dev --local
pnpm dev
```

Create `~/.workspace-viewer/config.json`:

```json
{
  "agent": {
    "agentId": "agent_dev",
    "agentToken": "dev-agent-token",
    "serverBaseUrl": "http://localhost:8787"
  },
  "workspaces": [
    {
      "workspaceId": "ws_dev",
      "displayName": "WorkspaceViewer Dev",
      "rootPath": "/home/slhaf/Documents/Projects/WorkspaceViewer",
      "accessMode": "read_only",
      "languages": ["typescript"],
      "ignore": [".git", "node_modules", "dist", ".wrangler"]
    }
  ]
}
```

Run the Agent:

```bash
pnpm agent:dev
```

Call the MCP-style endpoint:

```bash
curl -s http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"listWorkspaces","arguments":{"includeOffline":true}}}'
```

## Current Authentication Mode

The first implementation keeps OAuth routes reserved and uses `DEV_USER_ID` in Worker development mode. The D1 schema and route boundaries are in place for a later Workers OAuth Provider Library + GitHub OAuth integration.
