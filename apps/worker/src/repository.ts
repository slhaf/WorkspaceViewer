export interface UserRow {
  user_id: string;
  status: "active" | "suspended";
}

export interface AgentRow {
  agent_id: string;
  user_id: string;
  display_name: string;
  token_hash: string;
}

export interface WorkspaceRow {
  workspace_id: string;
  user_id: string;
  agent_id: string;
  display_name: string;
  agent_display_name: string | null;
  languages_json: string | null;
}

export async function getUser(db: D1Database, userId: string): Promise<UserRow | null> {
  return db.prepare("SELECT user_id, status FROM users WHERE user_id = ?")
    .bind(userId)
    .first<UserRow>();
}

export async function getAgentForToken(
  db: D1Database,
  agentId: string,
  token: string
): Promise<AgentRow | null> {
  return db.prepare(
    "SELECT agent_id, user_id, display_name, token_hash FROM agents WHERE agent_id = ? AND token_hash = ?"
  ).bind(agentId, token).first<AgentRow>();
}

export async function touchAgent(db: D1Database, agentId: string): Promise<void> {
  await db.prepare("UPDATE agents SET last_seen_at = CURRENT_TIMESTAMP WHERE agent_id = ?")
    .bind(agentId)
    .run();
}

export async function listWorkspacesForUser(
  db: D1Database,
  userId: string
): Promise<WorkspaceRow[]> {
  const result = await db.prepare(`
    SELECT
      w.workspace_id,
      w.user_id,
      w.agent_id,
      w.display_name,
      a.display_name AS agent_display_name,
      w.languages_json
    FROM workspaces w
    JOIN agents a ON a.agent_id = w.agent_id
    WHERE w.user_id = ?
    ORDER BY w.display_name
  `).bind(userId).all<WorkspaceRow>();
  return result.results ?? [];
}

export async function getWorkspaceForUser(
  db: D1Database,
  userId: string,
  workspaceId: string
): Promise<WorkspaceRow | null> {
  return db.prepare(`
    SELECT
      w.workspace_id,
      w.user_id,
      w.agent_id,
      w.display_name,
      a.display_name AS agent_display_name,
      w.languages_json
    FROM workspaces w
    JOIN agents a ON a.agent_id = w.agent_id
    WHERE w.user_id = ? AND w.workspace_id = ?
  `).bind(userId, workspaceId).first<WorkspaceRow>();
}

export function parseLanguages(languagesJson: string | null): string[] | undefined {
  if (!languagesJson) return undefined;
  try {
    const parsed = JSON.parse(languagesJson);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
