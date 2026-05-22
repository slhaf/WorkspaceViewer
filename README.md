# Workspace Viewer

English | [中文](./README.zh-CN.md)

Workspace Viewer is a read-only local workspace viewer for ChatGPT Apps and MCP.

It lets ChatGPT inspect user-approved local workspaces through a local Agent, without giving the cloud service direct access to the user's filesystem.

The first version focuses on a conservative safety model: discover registered workspaces, list file trees, inspect text files, search paths or file contents, and batch multiple read-only checks. It does not execute shell commands, write files, delete files, or access directories that the user has not explicitly registered.

Website: [https://workspace-viewer.slhaf.work](https://workspace-viewer.slhaf.work)

---

## Why this exists

ChatGPT is useful for code understanding, debugging, documentation, and refactoring discussions, but it usually cannot inspect a user's local project directly.

Workspace Viewer provides a narrow bridge:

- the user runs a local Agent on their own machine;
- the user registers only the local directories they want to expose;
- ChatGPT calls MCP tools through the hosted Worker;
- the Worker relays read-only requests to the user's local Agent;
- the Agent reads from approved workspace roots and returns bounded text results.

This keeps local filesystem access under the user's control while still making project inspection available to ChatGPT.

---

## Safety model

Workspace Viewer is intentionally limited.

It can:

- list approved workspaces;
- describe a workspace at a high level;
- list directory trees inside a workspace;
- inspect text files by path and line range;
- search file paths or text content;
- run a batch of read-only workspace checks.

It cannot:

- execute shell commands;
- write files;
- modify files;
- delete files;
- access unregistered directories;
- access paths outside a registered workspace root;
- directly browse the user's machine from the hosted Worker.

The local Agent is the final filesystem boundary. It validates workspace IDs, normalizes paths, rejects path traversal, applies ignore rules, and limits output size.

---

## Architecture

Workspace Viewer uses a hosted Worker plus a local Agent.

```text
ChatGPT
  ↓ MCP tool call
Cloudflare Worker
  ↓ OAuth / user / workspace validation
Durable Object AgentSession
  ↓ WebSocket relay
Local Agent
  ↓ read-only filesystem inspection
Registered local workspace
```

Main components:

- `apps/worker`: Cloudflare Worker, OAuth flow, D1 metadata, Durable Object relay, and MCP endpoint.
- `apps/agent`: local Node.js Agent that connects to the Worker and serves read-only workspace requests.
- `packages/protocol`: shared schemas, limits, tool names, and protocol types.

The Worker does not mount, sync, or directly access local files. Actual filesystem reads happen only inside the local Agent process.

---

## Tools

The v1 MCP tool set includes:

| Tool                     | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `listWorkspaces`         | List registered workspaces available to the current user. |
| `describeWorkspace`      | Return a lightweight overview of a workspace.             |
| `listTree`               | List a directory tree inside a workspace.                 |
| `inspectFile`            | Read a text file or line range.                           |
| `searchFile`             | Search by path or text content.                           |
| `batchExec`              | Execute multiple read-only workspace checks in one call.  |
| `createAgentPairingCode` | Create a pairing code for connecting a local Agent.       |

---

## Repository layout

```text
.
├── apps
│   ├── agent      # Local workspace Agent
│   └── worker     # Cloudflare Worker / MCP server
├── packages
│   └── protocol   # Shared protocol schemas and limits
└── workspace_viewer_architecture_spec.md
```

---

## Development

Install dependencies and build all packages:

```bash
pnpm install
pnpm build
```

Run type checks and tests:

```bash
pnpm typecheck
pnpm test
```

Run the Worker locally:

```bash
cd apps/worker
pnpm wrangler d1 migrations apply workspace-viewer-dev --local
pnpm dev
```

Run the Agent locally:

```bash
pnpm agent:dev
```

For local-only development without OAuth, set `DEV_AUTH_BYPASS_ENABLED=true` in a local Wrangler environment. Do not enable this in production.

---

## Agent configuration

The Agent stores local configuration under:

```text
~/.workspace-viewer/config.json
```

Example shape:

```json
{
  "agent": {
    "agentId": "<agent-id>",
    "agentToken": "<agent-token>",
    "serverBaseUrl": "https://<your-worker-domain>/mcp"
  },
  "workspaces": [
    {
      "workspaceId": "<workspace-id>",
      "displayName": "Example Workspace",
      "rootPath": "/path/to/workspace",
      "accessMode": "read_only",
      "languages": ["typescript"]
    }
  ]
}
```

Workspace root paths are stored locally. The hosted Worker stores only workspace metadata needed for routing and discovery.

---

## Pairing flow

The normal flow is:

1. Sign in through the ChatGPT App OAuth flow.
2. Ask ChatGPT to create an Agent pairing code.
3. Run the local Agent pairing command.
4. Register one or more local workspaces.
5. Start the Agent.
6. ChatGPT can now inspect approved workspaces through MCP tools.

Example commands:

```bash
workspace-viewer-agent pair <PAIRING-CODE>
workspace-viewer-agent workspace add --name "Example Workspace" --path /path/to/workspace
workspace-viewer-agent run
```

To revoke local Agent credentials while keeping local workspace entries:

```bash
workspace-viewer-agent unpair
```

---

## Production configuration

Production deployments require OAuth and Cloudflare resources.

Required Worker secrets:

```bash
cd apps/worker
pnpm wrangler secret put GITHUB_CLIENT_ID
pnpm wrangler secret put GITHUB_CLIENT_SECRET
pnpm wrangler secret put OAUTH_COOKIE_SECRET
```

Optional reviewer login for ChatGPT Apps review:

```bash
cd apps/worker
pnpm wrangler secret put REVIEW_EMAIL
pnpm wrangler secret put REVIEW_PASSWORD_HASH
pnpm wrangler secret put REVIEW_PROVIDER_SUBJECT
```

`REVIEW_PASSWORD_HASH` should be formatted as:

```text
sha256:<hex-encoded-sha256-password-hash>
```

Do not commit real secrets, real reviewer credentials, or production-only tokens.

---

## Development seed data

Development seed SQL, if present, is kept outside the production migration path.

Do not apply development seed data to production D1 databases. In particular, avoid fixed development Agent IDs, workspace IDs, or tokens in any production environment.

---

## Current status

Workspace Viewer is currently an early version intended for ChatGPT Apps / MCP publishing and review.

Implemented:

- hosted Worker MCP endpoint;
- OAuth-protected access;
- local Agent pairing;
- Durable Object based Agent relay;
- D1-backed metadata;
- read-only workspace tools;
- bounded output handling;
- reviewer login support for app review.

Planned or possible future work:

- richer project summaries;
- symbol-level navigation;
- diagnostics integration;
- LSP-assisted code understanding;
- better installation and onboarding flow.

---

## License

Licensed under the Apache License 2.0. See [LICENSE](./LICENSE).
