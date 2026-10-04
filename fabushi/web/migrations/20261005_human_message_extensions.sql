ALTER TABLE direct_messages ADD COLUMN reply_to_message_id INTEGER REFERENCES direct_messages(id);
ALTER TABLE direct_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(attachments_json));

CREATE TABLE IF NOT EXISTS direct_message_resources (
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0 AND size <= 26214400),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_direct_message_resources_owner
  ON direct_message_resources(owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS direct_message_reactions (
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  emoji TEXT NOT NULL CHECK (length(emoji) > 0 AND length(emoji) <= 32),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id, emoji),
  FOREIGN KEY (message_id) REFERENCES direct_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_direct_message_reactions_message
  ON direct_message_reactions(message_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_direct_messages_pair_id
  ON direct_messages(sender_user_id, recipient_user_id, id);
