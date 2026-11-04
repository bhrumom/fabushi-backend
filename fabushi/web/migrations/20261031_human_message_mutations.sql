-- Stage-A source implementation for canonical Human direct-message mutations.
-- Validation is intentionally deferred by FMEP-001; this migration is additive.

ALTER TABLE direct_messages
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

ALTER TABLE direct_messages
  ADD COLUMN edited_at TEXT;

ALTER TABLE direct_messages
  ADD COLUMN deleted_at TEXT;

CREATE TABLE IF NOT EXISTS direct_message_mutations (
  sender_user_id INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('edit', 'delete')),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
  result_revision INTEGER NOT NULL CHECK (result_revision >= 1),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (sender_user_id, operation_id),
  FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES direct_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_direct_message_mutations_message
  ON direct_message_mutations(message_id, created_at ASC);
