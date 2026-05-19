import type { AgentSession } from "./session.js";

export interface Env {
  DB: D1Database;
  AGENT_SESSION: DurableObjectNamespace<AgentSession>;
  DEV_USER_ID?: string;
  ENVIRONMENT?: string;
}
