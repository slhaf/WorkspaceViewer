# Workspace Viewer 架构与实现规格

## 项目目标

Workspace Viewer 是一个面向 ChatGPT Apps 的本地工作区访问层。

它的目标是：

- 让用户将本地代码工作区注册到自己的 Agent；
- 让 ChatGPT 通过 MCP 工具按需查看这些工作区；
- 提供适合代码理解的只读能力，例如目录查看、文件检查、路径搜索、内容搜索与批量调用；
- 通过 Cloudflare Workers + Durable Objects 承担公开接入与实时 Agent 会话；
- 为后续扩展 LSP、诊断、符号跳转等高级工作区理解能力预留架构空间。

---

# 1. 总体架构

Workspace Viewer 采用：

> **Cloudflare Workers + Durable Objects + D1 + Local Agent**

整体链路：

```text
ChatGPT
  ↓ MCP Tool Call
Cloudflare Worker
  ↓ dispatch
Durable Object: AgentSession
  ↓ WebSocket
Local Agent
  ↓ gzip compressed result
Durable Object
  ↓ compressed payload
Cloudflare Worker
  ↓ decompress + normalize
ChatGPT
```

---

# 2. 各组件职责

## 2.1 Cloudflare Worker

Worker 是公开入口与 MCP 业务层。

职责：

- 提供 ChatGPT App / MCP Server；
- 接收 MCP Tool Call；
- 鉴权并识别用户；
- 校验用户是否可访问目标 Workspace；
- 查询 D1 中的 Agent / Workspace 元数据；
- 定位对应 Durable Object；
- 调用 Durable Object 发起一次工具请求；
- 接收 Durable Object 返回的 gzip 压缩结果；
- 解压缩；
- 校验 Agent 返回结构；
- 做工具级输出限制、截断与错误标准化；
- 返回 ChatGPT 可直接理解的 MCP Tool Result。

Worker 不负责：

- 持有 Agent 长连接；
- 直接执行本地 Workspace 操作；
- 保存实时连接态。

---

## 2.2 Durable Object：AgentSession

每个在线 Agent 对应一个 AgentSession Durable Object。

建议映射：

```text
agentId -> Durable Object instance
```

职责：

- 接收 Agent 的 WebSocket 连接；
- 维护当前 Agent 在线连接；
- 维护一次工具调用期间的 `requestId -> waiter`；
- 接收 Worker 发来的 dispatch 请求；
- 将请求通过 WebSocket 推送给 Agent；
- 等待 Agent 回传 gzip 压缩结果；
- 将压缩字节透传返回给 Worker；
- 处理超时、断连、Agent 忙碌等错误；
- 采用 WebSocket Hibernation API，空闲时允许休眠。

Durable Object 不负责：

- 解压结果；
- 解析 Workspace 工具正文；
- 长期持久化业务数据。

---

## 2.3 D1

D1 保存系统元数据。

负责存储：

- 用户信息；
- GitHub 登录身份与内部用户映射；
- Agent 注册信息；
- Workspace 注册信息；
- Agent 与 Workspace 的归属关系；
- Agent pairing session；
- OAuth 相关授权状态或 provider 所需持久数据。

建议核心表：

```text
users
- user_id PK
- auth_provider: github
- provider_subject
- login_name nullable
- email nullable
- status: active | suspended
- created_at

agents
- agent_id PK
- user_id
- display_name
- token_hash
- created_at
- last_seen_at nullable

workspaces
- workspace_id PK
- user_id
- agent_id
- display_name
- access_mode: read_only
- languages_json nullable
- created_at

pairing_sessions
- code PK
- user_id
- expires_at
- used_at nullable
```

说明：

- `provider_subject` 对应 GitHub 用户唯一标识；
- `user_id` 是 Workspace Viewer 内部用户标识；
- 后续若扩展其他登录方式，可将 `auth_provider` 扩展为枚举。

---

## 2.4 Local Agent

Local Agent 运行在用户设备上，负责真实 Workspace 访问。

职责：

- 本地保存 Agent 凭证与 Workspace 配置；
- 与 Durable Object 建立 WebSocket 长连接；
- 按心跳或连接状态维持在线；
- 接收 Durable Object 推送的工具请求；
- 校验请求格式；
- 在本地 Workspace 中执行只读操作；
- 将工具结果序列化；
- 对结果执行 gzip 压缩；
- 通过 WebSocket 返回压缩结果。

Agent 必须做最终安全控制：

- 仅访问已注册 Workspace；
- 所有路径以 Workspace root 为根；
- 路径 normalize 后不得逃逸 root；
- 防止符号链接逃逸；
- 应用 ignore 规则；
- 限制单次工具结果体积；
- 限制单次工具执行时长。

---

# 3. 核心运行链路

## 3.1 Agent 建立在线连接

```text
1. Agent 读取本地配置
2. Agent 发起 WebSocket 连接：/agent/connect?agentId=...
3. Worker / Durable Object 校验 Agent token
4. 连接绑定到对应 AgentSession Durable Object
5. Agent 进入在线状态
```

---

## 3.2 MCP 工具调用链路

以 `inspectFile` 为例：

```text
1. ChatGPT 调用 inspectFile
2. Worker 校验用户身份
3. Worker 校验 workspaceId 属于当前用户
4. Worker 从 D1 查询 workspaceId -> agentId
5. Worker 定位 agentId 对应 Durable Object
6. Worker 向 Durable Object 发起 dispatch 请求
7. Durable Object：
   - 创建 requestId
   - 注册 waiter
   - 通过 WebSocket 将请求推送给 Agent
8. Agent 执行 inspectFile
9. Agent 对结果 gzip 压缩
10. Agent 通过 WebSocket 回传 requestId + compressed payload
11. Durable Object 唤醒 waiter，并将压缩结果返回 Worker
12. Worker 解压 gzip payload
13. Worker 校验结果 schema、裁剪输出
14. Worker 返回 MCP Tool Result 给 ChatGPT
```

---

# 4. 通信协议

## 4.1 Worker -> Durable Object Dispatch

```ts
export interface DispatchRequest {
  requestId: string;
  userId: string;
  agentId: string;
  workspaceId: string;
  tool: WorkspaceToolName;
  input: unknown;
  timeoutMs: number;
}
```

响应：

```ts
export interface DispatchResponse {
  requestId: string;
  ok: boolean;
  encoding?: 'gzip';
  compressedPayload?: ArrayBuffer;
  error?: RelayError;
}
```

---

## 4.2 Durable Object -> Agent WebSocket Request

```ts
export interface AgentToolRequest {
  type: 'tool_request';
  requestId: string;
  workspaceId: string;
  tool: WorkspaceToolName;
  input: unknown;
  timeoutMs: number;
}
```

---

## 4.3 Agent -> Durable Object WebSocket Result

推荐采用两帧协议：

### Frame 1：JSON Header

```ts
export interface AgentToolResultHeader {
  type: 'tool_result';
  requestId: string;
  ok: boolean;
  encoding: 'gzip';
  compressedBytes: number;
  uncompressedBytes: number;
  error?: WorkspaceToolError;
}
```

### Frame 2：Binary Body

```text
gzip compressed bytes
```

说明：

- 若 `ok = false` 且错误体很小，可允许只发 header，不发 binary body；
- 若 `ok = true`，二进制 body 必须存在；
- Durable Object 不解压 body，只做匹配与透传。

---

# 5. 工具集合

MCP 层 v1 工具集合：

```text
listWorkspaces
describeWorkspace
listTree
inspectFile
searchFile
batchExec
```

---

# 6. Tool: listWorkspaces

## 6.1 用途

列出当前用户已经注册的 Workspace，供模型发现可用的 `workspaceId`，同时返回对应 Agent 的在线状态与基础摘要。

这是模型进入系统后的工作区发现入口。

## 6.2 输入

```ts
export interface ListWorkspacesInput {
  includeOffline?: boolean;
}
```

## 6.3 输出

```ts
export interface ListWorkspacesResult {
  workspaces: Array<{
    workspaceId: string;
    displayName: string;
    agentId: string;
    agentDisplayName?: string;
    agentOnline: boolean;
    languages?: string[];
  }>;
}
```

## 6.4 说明

- `workspaceId` 后续作为其他 Workspace 工具的输入；
- `agentOnline = false` 的 Workspace 仍可返回，用于告知模型当前暂不可访问；
- 若 `includeOffline = false`，可只返回在线 Agent 下的 Workspace。

---

# 7. Tool: describeWorkspace

## 6.1 用途

获取 Workspace 的基础概览，作为模型进入项目时的低成本入口。

## 6.2 输入

```ts
export interface DescribeWorkspaceInput {
  workspaceId: string;
}
```

## 6.3 输出

```ts
export interface DescribeWorkspaceResult {
  workspaceId: string;
  displayName: string;
  languages?: string[];
  rootEntries: Array<{
    name: string;
    type: 'file' | 'directory';
  }>;
  markers?: string[];
}
```

## 6.4 说明

`markers` 可用于返回低成本识别出的项目特征，例如：

```text
maven
node-package
python-project
git-repository
```

第一版允许只返回较基础的 markers。

---

# 8. Tool: listTree

## 7.1 用途

列出指定目录下的层级结构。

## 7.2 输入

```ts
export interface ListTreeInput {
  workspaceId: string;
  path?: string;
  depth?: number;
  includeFiles?: boolean;
}
```

## 7.3 输出

```ts
export interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeEntry[];
}

export interface ListTreeResult {
  path: string;
  depth: number;
  entries: TreeEntry[];
  truncated: boolean;
}
```

## 7.4 建议限制

```text
maxDepth = 4
maxEntries = 1000
maxUncompressedResultBytes = 256 KB
```

---

# 9. Tool: inspectFile

## 8.1 用途

读取文本文件的指定区间，并返回基础文件信息。

## 8.2 输入

```ts
export interface InspectFileInput {
  workspaceId: string;
  path: string;
  startLine?: number;
  endLine?: number;
}
```

## 8.3 输出

```ts
export interface InspectFileResult {
  path: string;
  language?: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
}
```

## 8.4 建议限制

```text
maxLines = 400
maxUncompressedResultBytes = 128 KB
```

---

# 10. Tool: searchFile

## 9.1 用途

统一承担两类搜索：

```text
1. 按路径 / 文件名搜索
2. 按文件内容搜索
```

## 9.2 输入

```ts
export type SearchFileMode = 'path' | 'content';

export interface SearchFileInput {
  workspaceId: string;
  mode: SearchFileMode;
  query: string;
  pathPrefix?: string;
  fileGlob?: string[];
  maxResults?: number;
  contextLines?: number;
}
```

## 9.3 输出：path 模式

```ts
export interface SearchPathMatch {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export interface SearchPathResult {
  mode: 'path';
  query: string;
  matches: SearchPathMatch[];
  truncated: boolean;
}
```

## 9.4 输出：content 模式

```ts
export interface SearchContentMatch {
  path: string;
  line: number;
  preview: string;
  before?: string[];
  after?: string[];
}

export interface SearchContentResult {
  mode: 'content';
  query: string;
  matches: SearchContentMatch[];
  truncated: boolean;
}
```

## 9.5 建议限制

```text
queryLength <= 256
maxResults <= 50
contextLines <= 3
searchTimeoutMs <= 5000
maxUncompressedResultBytes = 128 KB
```

---

# 11. Tool: batchExec

## 10.1 用途

一次性批量执行多个只读工具调用，减少模型多轮请求。

## 10.2 支持的子工具

第一版仅允许：

```text
describeWorkspace
listTree
inspectFile
searchFile
```

`listWorkspaces` 不放入 `batchExec`，因为它属于用户级发现工具，不依赖指定 Workspace。

`batchExec` 不允许递归调用 `batchExec`。

## 10.3 输入

```ts
export interface BatchExecInput {
  workspaceId: string;
  operations: BatchOperation[];
}

export type BatchOperation =
  | {
      id: string;
      tool: 'describeWorkspace';
      input: Omit<DescribeWorkspaceInput, 'workspaceId'>;
    }
  | {
      id: string;
      tool: 'listTree';
      input: Omit<ListTreeInput, 'workspaceId'>;
    }
  | {
      id: string;
      tool: 'inspectFile';
      input: Omit<InspectFileInput, 'workspaceId'>;
    }
  | {
      id: string;
      tool: 'searchFile';
      input: Omit<SearchFileInput, 'workspaceId'>;
    };
```

## 10.4 输出

```ts
export interface BatchExecResult {
  results: Array<{
    id: string;
    ok: boolean;
    result?: unknown;
    error?: WorkspaceToolError;
  }>;
}
```

## 10.5 建议限制

```text
maxOperations = 8
maxParallelism = 4
maxTotalTimeoutMs = 10000
maxUncompressedResultBytes = 512 KB
```

---

# 12. 错误模型

## 11.1 WorkspaceToolError

```ts
export interface WorkspaceToolError {
  code:
    | 'WORKSPACE_NOT_FOUND'
    | 'WORKSPACE_FORBIDDEN'
    | 'PATH_OUTSIDE_WORKSPACE'
    | 'PATH_IGNORED'
    | 'FILE_NOT_FOUND'
    | 'FILE_TOO_LARGE'
    | 'INVALID_PARAMS'
    | 'SEARCH_TIMEOUT'
    | 'RESULT_TOO_LARGE'
    | 'TOOL_TIMEOUT'
    | 'INTERNAL_ERROR';
  message: string;
  details?: Record<string, unknown>;
}
```

## 11.2 RelayError

```ts
export interface RelayError {
  code:
    | 'AGENT_OFFLINE'
    | 'AGENT_BUSY'
    | 'AGENT_TIMEOUT'
    | 'AGENT_PROTOCOL_ERROR'
    | 'COMPRESSED_RESULT_TOO_LARGE'
    | 'INTERNAL_ERROR';
  message: string;
}
```

---

# 13. 压缩策略

## 12.1 压缩算法

v1 固定使用：

```text
gzip
```

原因：

- Cloudflare Worker 原生支持 gzip 解压；
- 对源码、JSON、路径列表已具备较高压缩收益；
- 比 zstd 更适合当前 Workers 免费层运行约束。

## 12.2 压缩位置

```text
Local Agent：压缩
Durable Object：透传
Cloudflare Worker：解压
```

## 12.3 大小校验

### Agent 侧

先限制**原始结果大小**，再压缩。

### Durable Object 侧

限制压缩结果大小：

```text
maxCompressedPayloadBytes = 按工具或总策略配置
```

### Worker 侧

解压前后都要校验：

```text
compressedBytes cap
uncompressedBytes cap
```

禁止压缩炸弹。

---

# 14. 认证边界

## 14.1 OAuth 方案

正式发布形态采用：

```text
Cloudflare Workers OAuth Provider Library
+ GitHub OAuth 登录
+ D1 用户映射
```

职责划分：

```text
ChatGPT
  = OAuth Client

Workspace Viewer Worker
  = 面向 ChatGPT 的 OAuth Authorization Server
  = MCP Resource Server

GitHub
  = 第三方身份提供者
```

## 14.2 OAuth 基本流程

```text
1. ChatGPT 对受保护 MCP 工具发起调用
2. Worker 返回认证要求，触发 OAuth 流程
3. ChatGPT 跳转到 Worker 的授权入口
4. Worker 引导用户前往 GitHub 登录
5. GitHub 完成用户认证后回调 Worker
6. Worker 根据 GitHub 用户信息创建或解析内部 userId
7. Workers OAuth Provider Library 完成授权码 / token 签发
8. ChatGPT 后续携带 access token 调用 MCP tools
9. Worker 校验 token 后，将请求映射到内部 userId
```

## 14.3 Worker 负责的 OAuth 路由

OAuth 相关能力由 Worker 本身承载，不要求单独维护额外网站。

建议预留或实现以下路由：

```text
/authorize
/token
/register                  # 若采用 Dynamic Client Registration
/callback/github
```

说明：

- `/authorize` 用于启动授权流程；
- `/callback/github` 用于接收 GitHub OAuth 回调；
- `/token` 与 `/register` 由 OAuth Provider 能力配合实现；
- 授权页可由 Worker 直接返回极简 HTML，无需单独 Web 站点。

## 14.4 GitHub OAuth App

需要在 GitHub 创建 OAuth App。

至少配置：

```text
Application name
Homepage URL
Authorization callback URL
```

其中 callback URL 指向 Worker：

```text
https://<worker-domain>/callback/github
```

## 14.5 用户状态

用户状态保留基础启停能力：

```text
active | suspended
```

其中：

- `active` 用户可绑定 Agent、注册 Workspace、调用 Workspace 工具；
- `suspended` 用户的访问被拒绝。

## 14.6 Agent 身份

Agent 拥有独立凭证：

```text
agentId + agentToken
```

用于：

- 绑定到用户；
- 建立 AgentSession WebSocket；
- 证明该 Agent 属于对应用户。

---

# 15. 本地 Agent 配置

建议默认路径：

```text
~/.workspace-viewer/config.json
```

示例：

```json
{
  "agent": {
    "agentId": "agent_xxx",
    "agentToken": "secret_xxx",
    "serverBaseUrl": "https://workspace-viewer.example.workers.dev"
  },
  "workspaces": [
    {
      "workspaceId": "ws_partner",
      "displayName": "Partner",
      "rootPath": "/home/slhaf/Projects/Partner",
      "accessMode": "read_only",
      "ignore": [
        ".git",
        ".idea",
        "target",
        "build",
        "node_modules",
        ".gradle"
      ]
    }
  ]
}
```

---

# 16. 实现目标

## 15.1 第一阶段必须完成

### Cloudflare Worker

- MCP Server 基础接入；
- Tool schema 注册；
- Workers OAuth Provider Library 集成；
- GitHub OAuth 登录流程；
- `/authorize`、`/callback/github` 等认证相关路由；
- D1 查询用户 / Agent / Workspace；
- 将 OAuth 身份映射为内部 `userId`；
- Durable Object dispatch client；
- gzip 解压；
- 结果校验与统一错误映射；
- v1 工具：
  - listWorkspaces
  - describeWorkspace
  - listTree
  - inspectFile
  - searchFile
  - batchExec

### Durable Object

- Agent WebSocket 接入；
- 一个 agentId 对应一个 Durable Object；
- 连接维护；
- dispatch request；
- request waiter；
- 接收 Agent 两帧结果协议；
- 返回压缩 payload 给 Worker；
- 超时与 Agent offline / busy 处理；
- 使用 WebSocket Hibernation API。

### D1

- users / agents / workspaces / pairing_sessions 表；
- 基础查询；
- 开发态可先简化认证与配对，但表结构需要就位。

### Local Agent

- 本地配置读取；
- Agent WebSocket 连接；
- 接收并执行工具请求；
- Workspace path guard；
- ignore 规则；
- gzip 压缩返回结果；
- 两帧 WebSocket 结果协议；
- v1 工具实现：
  - describeWorkspace
  - listTree
  - inspectFile
  - searchFile
  - batchExec

---

## 15.2 第一阶段可先简化

为了先跑通主链路，可暂时：

- 使用开发态固定用户模拟 OAuth 后的 `userId`；
- 使用手工写入 D1 的 Agent / Workspace 数据；
- 暂不完整打通 GitHub OAuth 回调与 token 签发；
- 暂不实现完整 Agent pairing UI；
- 暂不实现多模态返回；
- 暂不实现 LSP。

但协议、表结构与 Worker 模块边界必须按照最终 OAuth 方案预留。

---

## 15.3 后续扩展

后续再考虑：

```text
- GitHub OAuth 正式联调
- Workers OAuth Provider Library 完整接入
- Agent pairing 完整流程
- Workspace 管理页
- LSP 工具：symbol / definition / references / diagnostics
- 多模态 workspace inspection
- 工具调用统计与额度监控
```

