import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { AgentClient } from "../src/client.js";
import type { PairedAgentConfig } from "../src/config.js";

describe("agent client config updates", () => {
  it("sends workspace_sync when workspaces change while connected", () => {
    const client = new AgentClient(configWithWorkspaces([]));
    const send = vi.fn();
    const close = vi.fn();
    Object.assign(client as unknown as { socket: unknown }, {
      socket: { readyState: WebSocket.OPEN, send, close }
    });

    client.updateConfig(configWithWorkspaces([{
      workspaceId: "ws_new",
      displayName: "New",
      rootPath: "/tmp/ws",
      accessMode: "read_only"
    }]));

    expect(close).not.toHaveBeenCalled();
    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toEqual({
      type: "workspace_sync",
      agentId: "agent_test",
      workspaces: [{
        workspaceId: "ws_new",
        displayName: "New",
        accessMode: "read_only"
      }]
    });
  });

  it("reconnects instead of syncing when pairing changes", () => {
    const client = new AgentClient(configWithWorkspaces([]));
    const send = vi.fn();
    const close = vi.fn();
    Object.assign(client as unknown as { socket: unknown }, {
      socket: { readyState: WebSocket.OPEN, send, close }
    });

    client.updateConfig({
      ...configWithWorkspaces([]),
      agent: {
        agentId: "agent_other",
        agentToken: "token_other",
        serverBaseUrl: "https://worker.example.com/mcp"
      }
    });

    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

function configWithWorkspaces(workspaces: PairedAgentConfig["workspaces"]): PairedAgentConfig {
  return {
    agent: {
      agentId: "agent_test",
      agentToken: "token_test",
      serverBaseUrl: "https://worker.example.com/mcp"
    },
    workspaces
  };
}
