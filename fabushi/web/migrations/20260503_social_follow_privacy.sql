-- Social follow and practice privacy support
-- Safe to run multiple times in Cloudflare D1.

CREATE TABLE IF NOT EXISTS user_follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_username TEXT NOT NULL,
  following_username TEXT NOT NULL,
  sync_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(follower_username, following_username)
);

CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_username);
CREATE INDEX IF NOT EXISTS idx_user_follows_following ON user_follows(following_username);
CREATE INDEX IF NOT EXISTS idx_user_follows_created_at ON user_follows(created_at DESC);

CREATE TABLE IF NOT EXISTS user_practice_privacy (
  username TEXT PRIMARY KEY,
  is_private INTEGER DEFAULT 0 NOT NULL,
  show_practice_name INTEGER DEFAULT 1 NOT NULL,
  show_duration INTEGER DEFAULT 1 NOT NULL,
  show_chant_count INTEGER DEFAULT 1 NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_practice_privacy_private ON user_practice_privacy(is_private);
