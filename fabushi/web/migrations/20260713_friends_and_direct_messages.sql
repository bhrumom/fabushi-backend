-- Durable friend requests and one-to-one messages used by every Mahayana
-- surface (CLI, desktop, mobile, and web).

CREATE TABLE IF NOT EXISTS friend_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_user_id INTEGER NOT NULL,
  sender_username TEXT NOT NULL,
  recipient_user_id INTEGER NOT NULL,
  recipient_username TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pending_pair
  ON friend_requests(sender_user_id, recipient_user_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_friend_requests_sender_status
  ON friend_requests(sender_user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient_status
  ON friend_requests(recipient_user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_user_id INTEGER NOT NULL,
  sender_username TEXT NOT NULL,
  recipient_user_id INTEGER NOT NULL,
  recipient_username TEXT NOT NULL,
  body TEXT NOT NULL,
  client_request_id TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT,
  FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_messages_client_request
  ON direct_messages(sender_user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation_sender
  ON direct_messages(sender_user_id, recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation_recipient
  ON direct_messages(recipient_user_id, sender_user_id, created_at DESC);

