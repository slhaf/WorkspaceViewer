# Workspace Viewer

[English](./README.md) | 中文

Workspace Viewer 是一个面向 ChatGPT Apps 与 MCP 的只读本地工作区查看器。

它允许 ChatGPT 通过本地 Agent 检查用户明确授权的本地工作区，同时避免云端服务直接访问用户文件系统。

第一版采用较保守的安全模型：发现已注册的工作区、列出目录树、查看文本文件、搜索路径或文件内容，以及批量执行多个只读检查。它不会执行 shell 命令，不会写入文件，不会删除文件，也不会访问用户未显式注册的目录。

网站：[https://workspace-viewer.slhaf.work](https://workspace-viewer.slhaf.work)

---

## 为什么需要它

ChatGPT 很适合用于代码理解、问题排查、文档整理和重构讨论，但通常不能直接检查用户的本地项目。

Workspace Viewer 提供了一条窄接口：

- 用户在自己的机器上运行本地 Agent；
- 用户只注册自己想暴露的本地目录；
- ChatGPT 通过托管 Worker 调用 MCP 工具；
- Worker 将只读请求转发给用户的本地 Agent；
- Agent 从已授权的工作区根目录读取内容，并返回受限大小的文本结果。

这样可以让本地文件系统访问权仍然掌握在用户手里，同时让 ChatGPT 获得必要的项目检查能力。

---

## 安全模型

Workspace Viewer 被有意限制在只读范围内。

它可以：

- 列出已授权的工作区；
- 返回工作区的轻量概览；
- 列出工作区内的目录树；
- 按路径和行号范围查看文本文件；
- 搜索文件路径或文本内容；
- 一次性执行多个只读工作区检查。

它不能：

- 执行 shell 命令；
- 写入文件；
- 修改文件；
- 删除文件；
- 访问未注册目录；
- 访问已注册工作区根目录之外的路径；
- 让托管 Worker 直接浏览用户机器。

本地 Agent 是最终的文件系统边界。它会校验 workspace ID，规范化路径，拒绝路径穿越，应用 ignore 规则，并限制输出大小。

---

## 架构

Workspace Viewer 由托管 Worker 和本地 Agent 组成。

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

主要组件：

- `apps/worker`：Cloudflare Worker、OAuth 流程、D1 元数据、Durable Object 转发层和 MCP endpoint。
- `apps/agent`：本地 Node.js Agent，连接 Worker 并处理只读工作区请求。
- `packages/protocol`：共享 schema、限制、工具名和协议类型。

Worker 不挂载、不同步，也不直接访问本地文件。实际的文件系统读取只发生在本地 Agent 进程内。

---

## 工具

v1 MCP 工具集包括：

| 工具 | 用途 |
| --- | --- |
| `listWorkspaces` | 列出当前用户可用的已注册工作区。 |
| `describeWorkspace` | 返回工作区的轻量概览。 |
| `listTree` | 列出工作区内的目录树。 |
| `inspectFile` | 读取文本文件或指定行号范围。 |
| `searchFile` | 按路径或文本内容搜索。 |
| `batchExec` | 一次性执行多个只读工作区检查。 |
| `createAgentPairingCode` | 创建用于连接本地 Agent 的配对码。 |

---

## 仓库结构

```text
.
├── apps
│   ├── agent      # 本地工作区 Agent
│   └── worker     # Cloudflare Worker / MCP server
├── packages
│   └── protocol   # 共享协议 schema 与限制
└── workspace_viewer_architecture_spec.md
```

---

## 开发

安装依赖并构建所有包：

```bash
pnpm install
pnpm build
```

运行类型检查和测试：

```bash
pnpm typecheck
pnpm test
```

本地运行 Worker：

```bash
cd apps/worker
pnpm wrangler d1 migrations apply workspace-viewer-dev --local
pnpm dev
```

本地运行 Agent：

```bash
pnpm agent:dev
```

如果只做本地开发且不需要 OAuth，可以在本地 Wrangler 环境中设置 `DEV_AUTH_BYPASS_ENABLED=true`。不要在生产环境启用它。

---

## Agent 配置

Agent 的本地配置文件位于：

```text
~/.workspace-viewer/config.json
```

配置结构示例：

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

工作区根路径只保存在本地。托管 Worker 只保存路由和发现所需的工作区元数据。

---

## 配对流程

正常流程如下：

1. 通过 ChatGPT App 的 OAuth 流程登录。
2. 让 ChatGPT 创建 Agent 配对码。
3. 运行本地 Agent 配对命令。
4. 注册一个或多个本地工作区。
5. 启动 Agent。
6. ChatGPT 即可通过 MCP 工具检查已授权的工作区。

示例命令：

```bash
workspace-viewer-agent pair <PAIRING-CODE>
workspace-viewer-agent workspace add --name "Example Workspace" --path /path/to/workspace
workspace-viewer-agent run
```

撤销本地 Agent 凭据但保留本地工作区条目：

```bash
workspace-viewer-agent unpair
```

---

## 生产配置

生产部署需要 OAuth 和 Cloudflare 资源。

必需的 Worker secrets：

```bash
cd apps/worker
pnpm wrangler secret put GITHUB_CLIENT_ID
pnpm wrangler secret put GITHUB_CLIENT_SECRET
pnpm wrangler secret put OAUTH_COOKIE_SECRET
```

用于 ChatGPT Apps 审核的可选 reviewer login：

```bash
cd apps/worker
pnpm wrangler secret put REVIEW_EMAIL
pnpm wrangler secret put REVIEW_PASSWORD_HASH
pnpm wrangler secret put REVIEW_PROVIDER_SUBJECT
```

`REVIEW_PASSWORD_HASH` 格式应为：

```text
sha256:<hex-encoded-sha256-password-hash>
```

不要提交真实 secret、真实 reviewer 凭据或仅用于生产环境的 token。

---

## 开发 seed 数据

如果存在开发用 seed SQL，它会被放在生产 migration 路径之外。

不要将开发 seed 数据应用到生产 D1 数据库。尤其不要在生产环境中使用固定的开发 Agent ID、workspace ID 或 token。

---

## 当前状态

Workspace Viewer 目前是一个早期版本，用于 ChatGPT Apps / MCP 发布与审核。

已实现：

- 托管 Worker MCP endpoint；
- OAuth 保护的访问流程；
- 本地 Agent 配对；
- 基于 Durable Object 的 Agent 转发；
- 基于 D1 的元数据；
- 只读工作区工具；
- 有界输出处理；
- 用于应用审核的 reviewer login 支持。

计划中或可能的后续方向：

- 更丰富的项目摘要；
- 符号级导航；
- 诊断信息集成；
- 基于 LSP 的代码理解；
- 更好的安装和引导流程。

---

## License

基于 Apache License 2.0 授权。详见 [LICENSE](./LICENSE)。
