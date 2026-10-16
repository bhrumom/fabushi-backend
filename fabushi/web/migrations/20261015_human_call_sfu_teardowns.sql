CREATE TABLE IF NOT EXISTS human_call_media_teardowns (
  id TEXT PRIMARY KEY,
  media_session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  client_teardown_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'uncertain', 'failed')),
  result_json TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (media_session_id, client_teardown_id),
  FOREIGN KEY (media_session_id) REFERENCES human_call_media_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (call_id) REFERENCES human_call_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_human_call_media_teardowns_session
  ON human_call_media_teardowns(media_session_id, status, updated_at DESC);
