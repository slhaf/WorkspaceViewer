import {
  CONTEXT7_TOOL_NAMES,
  type Context7ToolName
} from "@workspace-viewer/protocol";
import type { Env } from "./env.js";
import { callContext7Tool } from "./context7Tools.js";
import { callWorkspaceTool } from "./workspaceTools.js";

export async function callTool(
  env: Env,
  userId: string,
  name: string,
  args: unknown
): Promise<unknown> {
  if (isContext7ToolName(name)) {
    return callContext7Tool(env, userId, name, args);
  }
  return callWorkspaceTool(env, userId, name, args);
}

function isContext7ToolName(value: string): value is Context7ToolName {
  return (CONTEXT7_TOOL_NAMES as readonly string[]).includes(value);
}
