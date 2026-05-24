CREATE TABLE IF NOT EXISTS practice_books (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  user_id INTEGER,
  practice_title TEXT NOT NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  source_file_name TEXT,
  content_hash TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  remote_object_key TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_practice_books_owner_updated
  ON practice_books(user_id, username, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_practice_books_practice_active
  ON practice_books(user_id, username, practice_title, is_active);

CREATE INDEX IF NOT EXISTS idx_practice_books_username
  ON practice_books(username);
