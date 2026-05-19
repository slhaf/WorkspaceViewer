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

Optional reviewer login for ChatGPT Apps submission review:

```bash
cd apps/worker
pnpm wrangler secret put REVIEW_EMAIL
pnpm wrangler secret put REVIEW_PASSWORD_HASH
pnpm wrangler secret put REVIEW_PROVIDER_SUBJECT
```

Set `REVIEW_LOGIN_ENABLED=true` in the Worker environment to show the reviewer email/password form on the OAuth sign-in page. `REVIEW_PASSWORD_HASH` must be formatted as `sha256:<hex sha256 of password>`. If `REVIEW_PROVIDER_SUBJECT` is omitted, the Worker uses `openai-review`.

Set the GitHub OAuth App callback URL to:

```text
https://<worker-domain>/callback/github
```

After ChatGPT calls `createAgentPairingCode`, pair the local Agent:

```bash
workspace-viewer-agent pair ABCD-EFGH
workspace-viewer-agent workspace add --name WorkspaceViewer --path /home/slhaf/Documents/Projects/WorkspaceViewer
workspace-viewer-agent run
```

To revoke the Agent credentials while keeping local workspace entries:

```bash
workspace-viewer-agent unpair
```

The Agent stores local credentials in `~/.workspace-viewer/config.json`. Workspace root paths remain local-only; the Agent syncs only workspace summaries to D1 after WebSocket connect.

Example config:

```json
{
  "agent": {
    "agentId": "agent_dev",
    "agentToken": "dev-agent-token",
    "serverBaseUrl": "https://workspace-viewer.slhafzjw-workspace-viewer.workers.dev/mcp"
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
