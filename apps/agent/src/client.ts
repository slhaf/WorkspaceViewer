import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  LIMITS,
  type AgentToolRequest,
  agentToolRequestSchema,
  type AgentToolResultHeader,
  workspaceError
} from "@workspace-viewer/protocol";
import type { AgentConfig } from "./config.js";
import { executeTool } from "./tools.js";
import { toWorkspaceError } from "./errors.js";
import { gzipJson } from "./utils.js";

export class AgentClient {
  private socket: WebSocket | null = null;
  private sendQueue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly config: AgentConfig) {}

  async run(): Promise<void> {
    while (!this.stopped) {
      await this.connectOnce();
      if (!this.stopped) await sleep(1000);
    }
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  private async connectOnce(): Promise<void> {
    const url = new URL("/agent/connect", this.config.agent.serverBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("agentId", this.config.agent.agentId);

    await new Promise<void>((resolve) => {
      const proxyAgent = createProxyAgent(url);
      const ws = new WebSocket(url, {
        headers: {
          authorization: `Bearer ${this.config.agent.agentToken}`,
          "x-workspace-viewer-agent-version": "0.1.0"
        },
        agent: proxyAgent
      });
      this.socket = ws;

      ws.on("message", (data) => {
        if (typeof data !== "string" && !Buffer.isBuffer(data)) return;
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
        void this.handleMessage(text);
      });

      ws.on("close", () => resolve());
      ws.on("error", () => resolve());
    });
  }

  private async handleMessage(text: string): Promise<void> {
    let request: AgentToolRequest;
    try {
      request = agentToolRequestSchema.parse(JSON.parse(text));
    } catch {
      await this.enqueueResult({
        type: "tool_result",
        requestId: "unknown",
        ok: false,
        encoding: "gzip",
        compressedBytes: 0,
        uncompressedBytes: 0,
        error: workspaceError("INVALID_PARAMS", "Invalid tool request")
      });
      return;
    }

    try {
      const result = await withTimeout(
        executeTool(this.config, request.tool, request.input),
        Math.min(request.timeoutMs, LIMITS.batchExec.maxTotalTimeoutMs)
      );
      const { compressed, uncompressedBytes } = gzipJson(result);
      if (uncompressedBytes > LIMITS.relay.maxUncompressedPayloadBytes) {
        throw workspaceError("RESULT_TOO_LARGE", "Result exceeds uncompressed relay limit");
      }
      if (compressed.byteLength > LIMITS.relay.maxCompressedPayloadBytes) {
        throw workspaceError("RESULT_TOO_LARGE", "Result exceeds compressed relay limit");
      }
      await this.enqueueResult({
        type: "tool_result",
        requestId: request.requestId,
        ok: true,
        encoding: "gzip",
        compressedBytes: compressed.byteLength,
        uncompressedBytes
      }, compressed);
    } catch (error) {
      const toolError = typeof error === "object" && error !== null && "code" in error
        ? error as ReturnType<typeof workspaceError>
        : toWorkspaceError(error);
      await this.enqueueResult({
        type: "tool_result",
        requestId: request.requestId,
        ok: false,
        encoding: "gzip",
        compressedBytes: 0,
        uncompressedBytes: 0,
        error: toolError
      });
    }
  }

  private async enqueueResult(header: AgentToolResultHeader, body?: Buffer): Promise<void> {
    this.sendQueue = this.sendQueue.then(async () => {
      const ws = this.socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(header));
      if (body) ws.send(body);
    });
    await this.sendQueue;
  }
}

function createProxyAgent(url: URL): HttpsProxyAgent<string> | undefined {
  const proxy = url.protocol === "wss:"
    ? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy
    : process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(workspaceError("TOOL_TIMEOUT", "Tool execution timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
