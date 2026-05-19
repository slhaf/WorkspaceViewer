export interface UserRow {
  user_id: string;
  status: "active" | "suspended";
}

export interface GitHubUserInput {
  providerSubject: string;
  loginName: string;
  email?: string | null;
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

export interface PairingSessionRow {
  code: string;
  user_id: string;
  agent_display_name: string | null;
  expires_at: string;
  used_at: string | null;
}

export async function getUser(db: D1Database, userId: string): Promise<UserRow | null> {
  return db.prepare("SELECT user_id, status FROM users WHERE user_id = ?")
    .bind(userId)
    .first<UserRow>();
}

export async function upsertGitHubUser(db: D1Database, input: GitHubUserInput): Promise<UserRow> {
  const existing = await db.prepare(
    "SELECT user_id, status FROM users WHERE auth_provider = 'github' AND provider_subject = ?"
  ).bind(input.providerSubject).first<UserRow>();

  if (existing) {
    await db.prepare(`
      UPDATE users
      SET login_name = ?, email = ?
      WHERE user_id = ?
    `).bind(input.loginName, input.email ?? null, existing.user_id).run();
    return existing;
  }

  const userId = `user_${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO users (user_id, auth_provider, provider_subject, login_name, email, status)
    VALUES (?, 'github', ?, ?, ?, 'active')
  `).bind(userId, input.providerSubject, input.loginName, input.email ?? null).run();
  return { user_id: userId, status: "active" };
}

export async function getAgent(db: D1Database, agentId: string): Promise<AgentRow | null> {
  return db.prepare(
    "SELECT agent_id, user_id, display_name, token_hash FROM agents WHERE agent_id = ?"
  ).bind(agentId).first<AgentRow>();
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

export async function createPairingSession(
  db: D1Database,
  code: string,
  userId: string,
  agentDisplayName: string | undefined,
  expiresAt: string
): Promise<void> {
  await db.prepare(`
    INSERT INTO pairing_sessions (code, user_id, agent_display_name, expires_at)
    VALUES (?, ?, ?, ?)
  `).bind(code, userId, agentDisplayName ?? null, expiresAt).run();
}

export async function getPairingSession(db: D1Database, code: string): Promise<PairingSessionRow | null> {
  return db.prepare(`
    SELECT code, user_id, agent_display_name, expires_at, used_at
    FROM pairing_sessions
    WHERE code = ?
  `).bind(code).first<PairingSessionRow>();
}

export async function markPairingSessionUsed(db: D1Database, code: string, now: string): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE pairing_sessions
    SET used_at = ?
    WHERE code = ? AND used_at IS NULL AND expires_at > ?
  `).bind(now, code, now).run();
  return Boolean(result.meta.changes);
}

export async function createAgent(
  db: D1Database,
  agentId: string,
  userId: string,
  displayName: string,
  tokenHash: string
): Promise<void> {
  await db.prepare(`
    INSERT INTO agents (agent_id, user_id, display_name, token_hash)
    VALUES (?, ?, ?, ?)
  `).bind(agentId, userId, displayName, tokenHash).run();
}

export async function touchAgent(db: D1Database, agentId: string): Promise<void> {
  await db.prepare("UPDATE agents SET last_seen_at = CURRENT_TIMESTAMP WHERE agent_id = ?")
    .bind(agentId)
    .run();
}

export async function revokeAgent(db: D1Database, agentId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM workspaces WHERE agent_id = ?").bind(agentId),
    db.prepare("DELETE FROM agents WHERE agent_id = ?").bind(agentId)
  ]);
}

export async function replaceAgentWorkspaces(
  db: D1Database,
  agentId: string,
  userId: string,
  workspaces: Array<{
    workspaceId: string;
    displayName: string;
    accessMode: "read_only";
    languages?: string[] | undefined;
  }>
): Promise<void> {
  const keepIds = workspaces.map((workspace) => workspace.workspaceId);
  if (keepIds.length === 0) {
    await db.prepare("DELETE FROM workspaces WHERE agent_id = ?").bind(agentId).run();
  } else {
    const placeholders = keepIds.map(() => "?").join(", ");
    await db.prepare(`DELETE FROM workspaces WHERE agent_id = ? AND workspace_id NOT IN (${placeholders})`)
      .bind(agentId, ...keepIds)
      .run();
  }

  for (const workspace of workspaces) {
    await db.prepare(`
      INSERT INTO workspaces (workspace_id, user_id, agent_id, display_name, access_mode, languages_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        user_id = excluded.user_id,
        agent_id = excluded.agent_id,
        display_name = excluded.display_name,
        access_mode = excluded.access_mode,
        languages_json = excluded.languages_json
    `).bind(
      workspace.workspaceId,
      userId,
      agentId,
      workspace.displayName,
      workspace.accessMode,
      workspace.languages ? JSON.stringify(workspace.languages) : null
    ).run();
  }

  await touchAgent(db, agentId);
}

export async function bootstrapDevWorkspaceForUser(db: D1Database, userId: string): Promise<void> {
  const existing = await db.prepare("SELECT workspace_id FROM workspaces WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ workspace_id: string }>();
  if (existing) return;

  const devWorkspace = await db.prepare("SELECT workspace_id FROM workspaces WHERE user_id = 'user_dev' LIMIT 1")
    .first<{ workspace_id: string }>();
  if (!devWorkspace) return;

  await db.prepare("UPDATE agents SET user_id = ? WHERE user_id = 'user_dev'")
    .bind(userId)
    .run();
  await db.prepare("UPDATE workspaces SET user_id = ? WHERE user_id = 'user_dev'")
    .bind(userId)
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
