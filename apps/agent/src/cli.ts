#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AgentClient } from "./client.js";
import {
  type AgentConfig,
  defaultConfigPath,
  loadConfig,
  saveConfig
} from "./config.js";
import { completeAgentPairingResponseSchema } from "@workspace-viewer/protocol";

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case "run":
      await runAgent(args);
      return;
    case "login":
      await login(args);
      return;
    case "workspace":
      await workspace(args);
      return;
    default:
      usage();
      process.exitCode = 2;
  }
}

async function runAgent(args: string[]): Promise<void> {
  const configPath = option(args, "--config") ?? defaultConfigPath();
  const config = await loadConfig(configPath);
  const client = new AgentClient(config);
  process.on("SIGINT", () => client.stop());
  process.on("SIGTERM", () => client.stop());
  await client.run();
}

async function login(args: string[]): Promise<void> {
  const pairingCode = args.find((arg) => !arg.startsWith("--"));
  const server = option(args, "--server");
  const configPath = option(args, "--config") ?? defaultConfigPath();
  const displayName = option(args, "--name");
  if (!pairingCode || !server) {
    console.error("Usage: workspace-viewer-agent login <pairing-code> --server <url> [--config <path>] [--name <display>]");
    process.exitCode = 2;
    return;
  }

  const response = await fetch(new URL("/agent/pair/complete", server), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingCode,
      agentDisplayName: displayName
    })
  });
  if (!response.ok) {
    throw new Error(`Pairing failed: ${response.status} ${await response.text()}`);
  }
  const paired = completeAgentPairingResponseSchema.parse(await response.json());
  const existing = await loadConfigIfExists(configPath);
  await saveConfig({
    agent: {
      agentId: paired.agentId,
      agentToken: paired.agentToken,
      serverBaseUrl: paired.serverBaseUrl
    },
    workspaces: existing?.workspaces ?? []
  }, configPath);
  console.log(`Agent paired: ${paired.agentId}`);
}

async function workspace(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand !== "add") {
    console.error("Usage: workspace-viewer-agent workspace add --name <name> --path <path> [--config <path>] [--ignore <pattern>]");
    process.exitCode = 2;
    return;
  }

  const name = option(args, "--name");
  const rootPath = option(args, "--path");
  const configPath = option(args, "--config") ?? defaultConfigPath();
  const ignore = options(args, "--ignore");
  if (!name || !rootPath) {
    console.error("Usage: workspace-viewer-agent workspace add --name <name> --path <path> [--config <path>] [--ignore <pattern>]");
    process.exitCode = 2;
    return;
  }

  const realRoot = await realpath(rootPath);
  const config = await loadConfig(configPath);
  const workspaceId = `ws_${randomUUID()}`;
  const next: AgentConfig = {
    ...config,
    workspaces: [
      ...config.workspaces,
      {
        workspaceId,
        displayName: name,
        rootPath: realRoot,
        accessMode: "read_only",
        ...(ignore.length > 0 ? { ignore } : {})
      }
    ]
  };
  await saveConfig(next, configPath);
  console.log(`Workspace added: ${workspaceId}`);
  console.log("Restart the agent to sync workspace metadata.");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1];
    if (args[index] === name && value) values.push(value);
  }
  return values;
}

async function loadConfigIfExists(configPath: string): Promise<AgentConfig | null> {
  try {
    return await loadConfig(configPath);
  } catch {
    return null;
  }
}

function usage(): void {
  console.error([
    "Usage:",
    "  workspace-viewer-agent run [--config <path>]",
    "  workspace-viewer-agent login <pairing-code> --server <url> [--config <path>] [--name <display>]",
    "  workspace-viewer-agent workspace add --name <name> --path <path> [--config <path>] [--ignore <pattern>]"
  ].join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
