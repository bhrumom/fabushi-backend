-- Canonical account-scoped Story state shared by Desktop, mobile and web.
-- Story domain rules live in application code; D1 is the cross-device authority.

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  owner_username TEXT NOT NULL,
  story_json TEXT NOT NULL CHECK (json_valid(story_json)),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  pinned_to_profile INTEGER NOT NULL DEFAULT 0 CHECK (pinned_to_profile IN (0, 1)),
  protected_content INTEGER NOT NULL DEFAULT 0 CHECK (protected_content IN (0, 1)),
  allow_replies INTEGER NOT NULL DEFAULT 1 CHECK (allow_replies IN (0, 1)),
  anonymous_view_count INTEGER NOT NULL DEFAULT 0 CHECK (anonymous_view_count >= 0),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stories_owner_created
  ON stories(owner_user_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_stories_expiry
  ON stories(expires_at_ms, pinned_to_profile);

CREATE TABLE IF NOT EXISTS story_views (
  story_id TEXT NOT NULL,
  viewer_user_id INTEGER NOT NULL,
  viewer_actor_id TEXT NOT NULL,
  viewed_at_ms INTEGER NOT NULL,
  reaction TEXT,
  forwarded INTEGER NOT NULL DEFAULT 0 CHECK (forwarded IN (0, 1)),
  PRIMARY KEY (story_id, viewer_user_id),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
  FOREIGN KEY (viewer_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_story_views_viewer_time
  ON story_views(viewer_user_id, viewed_at_ms DESC);

CREATE TABLE IF NOT EXISTS story_stealth (
  user_id INTEGER PRIMARY KEY,
  enabled_till_ms INTEGER NOT NULL DEFAULT 0,
  cooldown_till_ms INTEGER NOT NULL DEFAULT 0,
  last_activation_request_id TEXT,
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_story_stealth_request
  ON story_stealth(user_id, last_activation_request_id)
  WHERE last_activation_request_id IS NOT NULL;
