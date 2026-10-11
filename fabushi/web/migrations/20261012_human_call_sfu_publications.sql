ALTER TABLE human_call_media_sessions
  ADD COLUMN mutation_state TEXT NOT NULL DEFAULT 'idle'
  CHECK (mutation_state IN ('idle', 'mutating', 'awaiting_endpoint_apply', 'retired'));

CREATE TABLE IF NOT EXISTS human_call_media_operations (
  id TEXT PRIMARY KEY,
  media_session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'awaiting_endpoint_apply', 'applied', 'uncertain', 'failed')),
  result_json TEXT,
  response_session_description_json TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (media_session_id, client_operation_id),
  FOREIGN KEY (media_session_id) REFERENCES human_call_media_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (call_id) REFERENCES human_call_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_human_call_media_operations_session
  ON human_call_media_operations(media_session_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS human_call_media_publications (
  id TEXT PRIMARY KEY,
  media_session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  client_publication_id TEXT NOT NULL,
  track_name TEXT NOT NULL,
  mid TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('audio', 'video')),
  status TEXT NOT NULL CHECK (status IN ('ready', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (media_session_id, client_publication_id),
  UNIQUE (media_session_id, track_name),
  FOREIGN KEY (media_session_id) REFERENCES human_call_media_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id) REFERENCES human_call_media_operations(id) ON DELETE CASCADE,
  FOREIGN KEY (call_id) REFERENCES human_call_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_human_call_media_publications_call
  ON human_call_media_publications(call_id, generation, status, updated_at DESC);
