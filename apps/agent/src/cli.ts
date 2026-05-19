#!/usr/bin/env node
import { AgentClient } from "./client.js";
import { defaultConfigPath, loadConfig } from "./config.js";

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command !== "run") {
    console.error("Usage: workspace-viewer-agent run [--config <path>]");
    process.exitCode = 2;
    return;
  }

  const configIndex = args.indexOf("--config");
  const configPath = configIndex >= 0 ? args[configIndex + 1] : defaultConfigPath();
  if (!configPath) {
    console.error("--config requires a path");
    process.exitCode = 2;
    return;
  }

  const config = await loadConfig(configPath);
  const client = new AgentClient(config);
  process.on("SIGINT", () => client.stop());
  process.on("SIGTERM", () => client.stop());
  await client.run();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
