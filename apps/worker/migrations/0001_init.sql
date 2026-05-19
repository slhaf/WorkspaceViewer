CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  auth_provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  login_name TEXT,
  email TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(auth_provider, provider_subject)
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  display_name TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode = 'read_only'),
  languages_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pairing_sessions (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_agent_id ON workspaces(agent_id);
