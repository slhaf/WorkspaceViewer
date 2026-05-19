INSERT OR IGNORE INTO users (user_id, auth_provider, provider_subject, login_name, status)
VALUES ('user_dev', 'github', 'dev', 'dev-user', 'active');

INSERT OR IGNORE INTO agents (agent_id, user_id, display_name, token_hash)
VALUES ('agent_dev', 'user_dev', 'Local Dev Agent', 'dev-agent-token');

INSERT OR IGNORE INTO workspaces (workspace_id, user_id, agent_id, display_name, access_mode, languages_json)
VALUES ('ws_dev', 'user_dev', 'agent_dev', 'WorkspaceViewer Dev', 'read_only', '["typescript"]');
