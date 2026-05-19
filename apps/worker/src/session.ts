import { DurableObject } from "cloudflare:workers";
import {
  LIMITS,
  type AgentControlMessage,
  agentControlMessageSchema,
  type AgentToolResultHeader,
  agentToolResultHeaderSchema,
  type DispatchRequest,
  type DispatchResponse,
  relayError
} from "@workspace-viewer/protocol";
import type { Env } from "./env.js";
import { getAgent, replaceAgentWorkspaces } from "./repository.js";

interface Waiter {
  request: DispatchRequest;
  resolve: (response: DispatchResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingBinary {
  header: AgentToolResultHeader;
}

interface AgentAttachment {
  agentId: string;
  connectedAt: number;
  clientVersion?: string;
}

export class AgentSession extends DurableObject<Env> {
  private readonly waiters = new Map<string, Waiter>();
  private pendingBinary: PendingBinary | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const agentId = url.searchParams.get("agentId");
    if (!agentId) {
      return new Response("agentId is required", { status: 400 });
    }

    for (const ws of this.ctx.getWebSockets()) {
      ws.close(4000, "Replaced by a newer agent connection");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["agent"]);
    const clientVersion = request.headers.get("x-workspace-viewer-agent-version") ?? undefined;
    const attachment: AgentAttachment = {
      agentId,
      connectedAt: Date.now()
    };
    if (clientVersion) attachment.clientVersion = clientVersion;
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async isOnline(): Promise<boolean> {
    return this.getAgentSocket() !== null;
  }

  async disconnect(reason = "Agent was unpaired"): Promise<void> {
    this.pendingBinary = null;
    this.failAll("AGENT_OFFLINE", reason);
    for (const ws of this.ctx.getWebSockets("agent")) {
      ws.close(4001, reason);
    }
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResponse> {
    const ws = this.getAgentSocket();
    if (!ws) {
      return {
        requestId: request.requestId,
        ok: false,
        error: relayError("AGENT_OFFLINE", "Agent is not connected")
      };
    }
    if (this.waiters.has(request.requestId)) {
      return {
        requestId: request.requestId,
        ok: false,
        error: relayError("INTERNAL_ERROR", "Duplicate request id")
      };
    }

    return new Promise<DispatchResponse>((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(request.requestId);
        resolve({
          requestId: request.requestId,
          ok: false,
          error: relayError("AGENT_TIMEOUT", "Agent did not return a result before timeout")
        });
      }, request.timeoutMs);

      this.waiters.set(request.requestId, { request, resolve, timeout });
      ws.send(JSON.stringify({
        type: "tool_request",
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        tool: request.tool,
        input: request.input,
        timeoutMs: request.timeoutMs
      }));
    });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    try {
      if (typeof message === "string") {
        await this.handleHeaderFrame(ws, message);
        return;
      }
      await this.handleBinaryFrame(ws, message);
    } catch {
      this.failAll("AGENT_PROTOCOL_ERROR", "Agent sent an invalid result frame");
      ws.close(4002, "Protocol error");
    }
  }

  async webSocketClose(): Promise<void> {
    this.pendingBinary = null;
    this.failAll("AGENT_OFFLINE", "Agent disconnected");
  }

  async webSocketError(): Promise<void> {
    this.pendingBinary = null;
    this.failAll("AGENT_OFFLINE", "Agent WebSocket error");
  }

  private async handleHeaderFrame(ws: WebSocket, message: string): Promise<void> {
    if (this.pendingBinary) {
      this.failWaiter(
        this.pendingBinary.header.requestId,
        "AGENT_PROTOCOL_ERROR",
        "Agent interleaved a header before sending the required binary body"
      );
      this.pendingBinary = null;
      ws.close(4002, "Interleaved result frames");
      return;
    }

    const raw = JSON.parse(message) as unknown;
    const control = agentControlMessageSchema.safeParse(raw);
    if (control.success) {
      await this.handleControlFrame(ws, control.data);
      return;
    }

    const parsed = agentToolResultHeaderSchema.parse(raw);
    const waiter = this.waiters.get(parsed.requestId);
    if (!waiter) {
      ws.close(4002, "Unknown request id");
      return;
    }

    if (!parsed.ok) {
      clearTimeout(waiter.timeout);
      this.waiters.delete(parsed.requestId);
      waiter.resolve({
        requestId: parsed.requestId,
        ok: false,
        error: parsed.error ?? relayError("AGENT_PROTOCOL_ERROR", "Agent returned an error without details")
      });
      return;
    }

    if (parsed.compressedBytes <= 0 || parsed.compressedBytes > LIMITS.relay.maxCompressedPayloadBytes) {
      this.failWaiter(parsed.requestId, "COMPRESSED_RESULT_TOO_LARGE", "Compressed result exceeds the relay limit");
      ws.close(4002, "Compressed result too large");
      return;
    }
    if (parsed.uncompressedBytes > LIMITS.relay.maxUncompressedPayloadBytes) {
      this.failWaiter(parsed.requestId, "COMPRESSED_RESULT_TOO_LARGE", "Uncompressed result exceeds the relay limit");
      ws.close(4002, "Uncompressed result too large");
      return;
    }

    this.pendingBinary = { header: parsed };
  }

  private async handleControlFrame(
    ws: WebSocket,
    message: AgentControlMessage
  ): Promise<void> {
    const attachment = ws.deserializeAttachment() as AgentAttachment | undefined;
    if (!attachment || message.agentId !== attachment.agentId) {
      ws.close(4002, "Agent identity mismatch");
      return;
    }

    const agent = await getAgent(this.env.DB, attachment.agentId);
    if (!agent) {
      ws.close(4002, "Unknown agent");
      return;
    }

    await replaceAgentWorkspaces(
      this.env.DB,
      attachment.agentId,
      agent.user_id,
      message.workspaces.map((workspace) => workspace.languages
        ? workspace
        : {
            workspaceId: workspace.workspaceId,
            displayName: workspace.displayName,
            accessMode: workspace.accessMode
          })
    );
  }

  private async handleBinaryFrame(ws: WebSocket, message: ArrayBuffer): Promise<void> {
    if (!this.pendingBinary) {
      ws.close(4002, "Binary frame without header");
      return;
    }

    const header = this.pendingBinary.header;
    this.pendingBinary = null;
    const waiter = this.waiters.get(header.requestId);
    if (!waiter) {
      ws.close(4002, "Missing waiter");
      return;
    }
    if (message.byteLength !== header.compressedBytes) {
      this.failWaiter(header.requestId, "AGENT_PROTOCOL_ERROR", "Binary body size does not match header");
      ws.close(4002, "Body size mismatch");
      return;
    }

    clearTimeout(waiter.timeout);
    this.waiters.delete(header.requestId);
    waiter.resolve({
      requestId: header.requestId,
      ok: true,
      encoding: "gzip",
      compressedPayload: message,
      uncompressedBytes: header.uncompressedBytes
    });
  }

  private getAgentSocket(): WebSocket | null {
    const sockets = this.ctx.getWebSockets("agent").filter((ws) => ws.readyState === WebSocket.OPEN);
    return sockets[0] ?? null;
  }

  private failWaiter(
    requestId: string,
    code: "AGENT_OFFLINE" | "AGENT_BUSY" | "AGENT_TIMEOUT" | "AGENT_PROTOCOL_ERROR" | "COMPRESSED_RESULT_TOO_LARGE" | "INTERNAL_ERROR",
    message: string
  ): void {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.waiters.delete(requestId);
    waiter.resolve({ requestId, ok: false, error: relayError(code, message) });
  }

  private failAll(
    code: "AGENT_OFFLINE" | "AGENT_PROTOCOL_ERROR",
    message: string
  ): void {
    for (const [requestId, waiter] of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve({ requestId, ok: false, error: relayError(code, message) });
    }
    this.waiters.clear();
  }
}
