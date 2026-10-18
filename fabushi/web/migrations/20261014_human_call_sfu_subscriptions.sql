ALTER TABLE human_call_media_operations
  ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'publish'
  CHECK (operation_kind IN ('publish', 'subscribe'));

CREATE TABLE IF NOT EXISTS human_call_media_subscriptions (
  id TEXT PRIMARY KEY,
  media_session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  client_subscription_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  receive_mid TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (media_session_id, client_subscription_id),
  UNIQUE (media_session_id, publication_id),
  UNIQUE (media_session_id, receive_mid),
  FOREIGN KEY (media_session_id) REFERENCES human_call_media_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id) REFERENCES human_call_media_operations(id) ON DELETE CASCADE,
  FOREIGN KEY (call_id) REFERENCES human_call_channels(id) ON DELETE CASCADE,
  FOREIGN KEY (publication_id) REFERENCES human_call_media_publications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_human_call_media_subscriptions_call
  ON human_call_media_subscriptions(call_id, generation, status, updated_at DESC);
