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

For local-only development without OAuth, set `DEV_AUTH_BYPASS_ENABLED=true` in `apps/worker/wrangler.jsonc` or your Wrangler environment.

## OAuth and Agent Pairing

The Worker is an OAuth-protected ChatGPT App MCP server. It uses Cloudflare Workers OAuth Provider Library, GitHub OAuth, DCR, and the single scope `workspace.access`.

Required production secrets:

```bash
cd apps/worker
pnpm wrangler secret put GITHUB_CLIENT_ID
pnpm wrangler secret put GITHUB_CLIENT_SECRET
pnpm wrangler secret put OAUTH_COOKIE_SECRET
```

Set the GitHub OAuth App callback URL to:

```text
https://<worker-domain>/callback/github
```

After ChatGPT calls `createAgentPairingCode`, pair the local Agent:

```bash
workspace-viewer-agent login ABCD-EFGH --server https://<worker-domain>
workspace-viewer-agent workspace add --name WorkspaceViewer --path /home/slhaf/Documents/Projects/WorkspaceViewer
workspace-viewer-agent run
```

The Agent stores local credentials in `~/.workspace-viewer/config.json`. Workspace root paths remain local-only; the Agent syncs only workspace summaries to D1 after WebSocket connect.

Example config:

```json
{
  "agent": {
    "agentId": "agent_dev",
    "agentToken": "dev-agent-token",
    "serverBaseUrl": "http://localhost:8787"
  },
  "workspaces": []
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

All workspace tools require OAuth unless the development bypass is explicitly enabled.
