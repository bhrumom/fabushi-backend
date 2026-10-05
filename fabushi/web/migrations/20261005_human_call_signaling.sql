CREATE TABLE IF NOT EXISTS human_call_channels (
  id TEXT PRIMARY KEY,
  creator_user_id INTEGER NOT NULL,
  peer_user_id INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  event_seq INTEGER NOT NULL DEFAULT 0,
  terminal_state TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_human_call_channels_creator_updated
  ON human_call_channels(creator_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_human_call_channels_peer_updated
  ON human_call_channels(peer_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS human_call_events (
  call_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  client_event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (call_id, seq),
  UNIQUE (call_id, user_id, device_id, client_event_id),
  FOREIGN KEY (call_id) REFERENCES human_call_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_human_call_events_replay
  ON human_call_events(call_id, seq ASC);
