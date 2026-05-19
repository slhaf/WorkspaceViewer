ALTER TABLE pairing_sessions ADD COLUMN agent_display_name TEXT;
ALTER TABLE pairing_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_pairing_sessions_user_id ON pairing_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_expires_at ON pairing_sessions(expires_at);
