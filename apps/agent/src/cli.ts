#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { completeAgentPairingResponseSchema } from "@workspace-viewer/protocol";
import { AgentClient } from "./client.js";
import {
  type AgentConfig,
  type WorkspaceConfig,
  defaultConfigPath,
  loadConfig,
  saveConfig
} from "./config.js";

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
  const pairingCode = firstPositional(args);
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
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list":
      await workspaceList(rest);
      return;
    case "add":
      await workspaceAdd(rest);
      return;
    case "remove":
      await workspaceRemove(rest);
      return;
    case "rename":
      await workspaceRename(rest);
      return;
    case "ignore":
      await workspaceIgnore(rest);
      return;
    default:
      workspaceUsage();
      process.exitCode = 2;
  }
}

async function workspaceList(args: string[]): Promise<void> {
  const configPath = option(args, "--config") ?? defaultConfigPath();
  const config = await loadConfig(configPath);
  if (config.workspaces.length === 0) {
    console.log("No workspaces configured.");
    return;
  }

  for (const workspace of config.workspaces) {
    console.log(`${workspace.workspaceId}\t${workspace.displayName}`);
    console.log(`  path: ${workspace.rootPath}`);
    console.log(`  access: ${workspace.accessMode}`);
    if (workspace.languages && workspace.languages.length > 0) {
      console.log(`  languages: ${workspace.languages.join(", ")}`);
    }
    if (workspace.ignore && workspace.ignore.length > 0) {
      console.log(`  ignore: ${workspace.ignore.join(", ")}`);
    }
  }
}

async function workspaceAdd(args: string[]): Promise<void> {
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
      normalizeWorkspace({
        workspaceId,
        displayName: name,
        rootPath: realRoot,
        accessMode: "read_only",
        ...(ignore.length > 0 ? { ignore: unique(ignore) } : {})
      })
    ]
  };
  await saveConfig(next, configPath);
  console.log(`Workspace added: ${workspaceId}`);
  printRestartNotice();
}

async function workspaceRemove(args: string[]): Promise<void> {
  const workspaceId = firstPositional(args);
  const configPath = option(args, "--config") ?? defaultConfigPath();
  if (!workspaceId) {
    console.error("Usage: workspace-viewer-agent workspace remove <workspace-id> [--config <path>]");
    process.exitCode = 2;
    return;
  }

  const config = await loadConfig(configPath);
  const workspace = requireWorkspace(config, workspaceId);
  const next: AgentConfig = {
    ...config,
    workspaces: config.workspaces.filter((candidate) => candidate.workspaceId !== workspace.workspaceId)
  };
  await saveConfig(next, configPath);
  console.log(`Workspace removed: ${workspace.workspaceId}`);
  printRestartNotice();
}

async function workspaceRename(args: string[]): Promise<void> {
  const workspaceId = firstPositional(args);
  const name = option(args, "--name");
  const configPath = option(args, "--config") ?? defaultConfigPath();
  if (!workspaceId || !name) {
    console.error("Usage: workspace-viewer-agent workspace rename <workspace-id> --name <name> [--config <path>]");
    process.exitCode = 2;
    return;
  }

  const config = await loadConfig(configPath);
  const workspace = requireWorkspace(config, workspaceId);
  const next = updateWorkspace(config, workspace.workspaceId, (current) => ({
    ...current,
    displayName: name
  }));
  await saveConfig(next, configPath);
  console.log(`Workspace renamed: ${workspace.workspaceId}`);
  printRestartNotice();
}

async function workspaceIgnore(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "add":
      await workspaceIgnoreAdd(rest);
      return;
    case "remove":
      await workspaceIgnoreRemove(rest);
      return;
    default:
      console.error("Usage: workspace-viewer-agent workspace ignore add <workspace-id> <pattern> [--config <path>]");
      console.error("       workspace-viewer-agent workspace ignore remove <workspace-id> <pattern> [--config <path>]");
      process.exitCode = 2;
  }
}

async function workspaceIgnoreAdd(args: string[]): Promise<void> {
  const [workspaceId, pattern] = positionals(args);
  const configPath = option(args, "--config") ?? defaultConfigPath();
  if (!workspaceId || !pattern) {
    console.error("Usage: workspace-viewer-agent workspace ignore add <workspace-id> <pattern> [--config <path>]");
    process.exitCode = 2;
    return;
  }

  const config = await loadConfig(configPath);
  const workspace = requireWorkspace(config, workspaceId);
  const ignore = unique([...(workspace.ignore ?? []), pattern]);
  const next = updateWorkspace(config, workspace.workspaceId, (current) => normalizeWorkspace({
    ...current,
    ignore
  }));
  await saveConfig(next, configPath);
  console.log(`Workspace ignore rule added: ${workspace.workspaceId} -> ${pattern}`);
  printRestartNotice();
}

async function workspaceIgnoreRemove(args: string[]): Promise<void> {
  const [workspaceId, pattern] = positionals(args);
  const configPath = option(args, "--config") ?? defaultConfigPath();
  if (!workspaceId || !pattern) {
    console.error("Usage: workspace-viewer-agent workspace ignore remove <workspace-id> <pattern> [--config <path>]");
    process.exitCode = 2;
    return;
  }

  const config = await loadConfig(configPath);
  const workspace = requireWorkspace(config, workspaceId);
  const ignore = (workspace.ignore ?? []).filter((candidate) => candidate !== pattern);
  if (ignore.length === (workspace.ignore ?? []).length) {
    throw new Error(`Ignore pattern is not configured on workspace ${workspace.workspaceId}: ${pattern}`);
  }
  const next = updateWorkspace(config, workspace.workspaceId, (current) => normalizeWorkspace({
    ...current,
    ...(ignore.length > 0 ? { ignore } : { ignore: undefined })
  }));
  await saveConfig(next, configPath);
  console.log(`Workspace ignore rule removed: ${workspace.workspaceId} -> ${pattern}`);
  printRestartNotice();
}

function requireWorkspace(config: AgentConfig, workspaceId: string): WorkspaceConfig {
  const workspace = config.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return workspace;
}

function updateWorkspace(
  config: AgentConfig,
  workspaceId: string,
  update: (workspace: WorkspaceConfig) => WorkspaceConfig
): AgentConfig {
  return {
    ...config,
    workspaces: config.workspaces.map((workspace) => workspace.workspaceId === workspaceId ? update(workspace) : workspace)
  };
}

function normalizeWorkspace(workspace: WorkspaceConfig): WorkspaceConfig {
  return workspace.ignore && workspace.ignore.length > 0
    ? workspace
    : omitIgnore(workspace);
}

function omitIgnore(workspace: WorkspaceConfig): WorkspaceConfig {
  const { ignore: _ignore, ...rest } = workspace;
  return rest;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function firstPositional(args: string[]): string | undefined {
  return positionals(args)[0];
}

function positionals(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value.startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
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

function printRestartNotice(): void {
  console.log("Restart the agent to sync workspace metadata.");
}

function workspaceUsage(): void {
  console.error([
    "Usage:",
    "  workspace-viewer-agent workspace list [--config <path>]",
    "  workspace-viewer-agent workspace add --name <name> --path <path> [--config <path>] [--ignore <pattern>]",
    "  workspace-viewer-agent workspace remove <workspace-id> [--config <path>]",
    "  workspace-viewer-agent workspace rename <workspace-id> --name <name> [--config <path>]",
    "  workspace-viewer-agent workspace ignore add <workspace-id> <pattern> [--config <path>]",
    "  workspace-viewer-agent workspace ignore remove <workspace-id> <pattern> [--config <path>]"
  ].join("\n"));
}

function usage(): void {
  console.error([
    "Usage:",
    "  workspace-viewer-agent run [--config <path>]",
    "  workspace-viewer-agent login <pairing-code> --server <url> [--config <path>] [--name <display>]",
    "  workspace-viewer-agent workspace list [--config <path>]",
    "  workspace-viewer-agent workspace add --name <name> --path <path> [--config <path>] [--ignore <pattern>]",
    "  workspace-viewer-agent workspace remove <workspace-id> [--config <path>]",
    "  workspace-viewer-agent workspace rename <workspace-id> --name <name> [--config <path>]",
    "  workspace-viewer-agent workspace ignore add <workspace-id> <pattern> [--config <path>]",
    "  workspace-viewer-agent workspace ignore remove <workspace-id> <pattern> [--config <path>]"
  ].join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
