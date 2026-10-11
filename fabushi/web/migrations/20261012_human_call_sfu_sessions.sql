CREATE TABLE IF NOT EXISTS human_call_media_sessions (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('publish', 'subscribe')),
  client_session_id TEXT NOT NULL,
  provider_session_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'uncertain', 'failed', 'closed')),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (call_id, user_id, device_id, client_session_id),
  FOREIGN KEY (call_id) REFERENCES human_call_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_human_call_media_sessions_active
  ON human_call_media_sessions(call_id, generation, status, updated_at DESC);
