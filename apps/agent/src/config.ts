import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const workspaceConfigSchema = z.object({
  workspaceId: z.string(),
  displayName: z.string(),
  rootPath: z.string(),
  accessMode: z.literal("read_only"),
  languages: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional()
});

const agentConfigSchema = z.object({
  agent: z.object({
    agentId: z.string(),
    agentToken: z.string(),
    serverBaseUrl: z.string().url()
  }),
  workspaces: z.array(workspaceConfigSchema)
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export function defaultConfigPath(): string {
  return path.join(homedir(), ".workspace-viewer", "config.json");
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<AgentConfig> {
  const raw = await readFile(configPath, "utf8");
  return agentConfigSchema.parse(JSON.parse(raw));
}

export async function saveConfig(config: AgentConfig, configPath = defaultConfigPath()): Promise<void> {
  const parsed = agentConfigSchema.parse(config);
  await mkdir(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
}
