-- v12 T01.1 identity-schema
-- Source custody and deployment identity are intentionally orthogonal.
CREATE TABLE IF NOT EXISTS mcp_app_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT UNIQUE NOT NULL,
  author TEXT NOT NULL,
  source_host TEXT,
  source_custody TEXT NOT NULL,
  repository_owner TEXT,
  repository_name TEXT,
  publisher TEXT NOT NULL,
  official_status TEXT NOT NULL DEFAULT 'user',
  source_provider TEXT,
  source_actor TEXT,
  source_transport TEXT,
  hosting_provider TEXT NOT NULL DEFAULT 'none',
  runtime_profile TEXT NOT NULL DEFAULT 'local-only',
  deployment_target TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_app_identity_repo
  ON mcp_app_identity(repository_owner, repository_name);

CREATE INDEX IF NOT EXISTS idx_mcp_app_identity_source_host
  ON mcp_app_identity(source_host);
