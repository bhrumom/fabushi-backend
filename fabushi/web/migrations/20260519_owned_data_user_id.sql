-- Backfill stable users.id ownership columns for mutable-username data.
-- This migration is for D1 databases that already ran the earlier username-key
-- social/sync/content migrations before users.id became the durable account key.

ALTER TABLE content_likes ADD COLUMN account_user_id INTEGER;
ALTER TABLE content_favorites ADD COLUMN user_id INTEGER;
ALTER TABLE comments ADD COLUMN account_user_id INTEGER;
ALTER TABLE user_follows ADD COLUMN follower_user_id INTEGER;
ALTER TABLE user_follows ADD COLUMN following_user_id INTEGER;
ALTER TABLE user_practice_privacy ADD COLUMN user_id INTEGER;
ALTER TABLE notifications ADD COLUMN user_id INTEGER;
ALTER TABLE notifications ADD COLUMN related_user_id INTEGER;
ALTER TABLE sync_log ADD COLUMN user_id INTEGER;
ALTER TABLE user_sync_state ADD COLUMN user_id INTEGER;

UPDATE content_likes
SET account_user_id = (SELECT users.id FROM users WHERE users.username = content_likes.username)
WHERE account_user_id IS NULL AND username IS NOT NULL;

UPDATE content_favorites
SET user_id = (SELECT users.id FROM users WHERE users.username = content_favorites.username)
WHERE user_id IS NULL AND username IS NOT NULL;

UPDATE comments
SET account_user_id = (SELECT users.id FROM users WHERE users.username = comments.username)
WHERE account_user_id IS NULL AND username IS NOT NULL;

UPDATE user_follows
SET follower_user_id = (SELECT users.id FROM users WHERE users.username = user_follows.follower_username)
WHERE follower_user_id IS NULL AND follower_username IS NOT NULL;

UPDATE user_follows
SET following_user_id = (SELECT users.id FROM users WHERE users.username = user_follows.following_username)
WHERE following_user_id IS NULL AND following_username IS NOT NULL;

UPDATE user_practice_privacy
SET user_id = (SELECT users.id FROM users WHERE users.username = user_practice_privacy.username)
WHERE user_id IS NULL AND username IS NOT NULL;

UPDATE notifications
SET user_id = (SELECT users.id FROM users WHERE users.username = notifications.username)
WHERE user_id IS NULL AND username IS NOT NULL;

UPDATE notifications
SET related_user_id = (SELECT users.id FROM users WHERE users.username = notifications.related_username)
WHERE related_user_id IS NULL AND related_username IS NOT NULL;

UPDATE sync_log
SET user_id = (SELECT users.id FROM users WHERE users.username = sync_log.username)
WHERE user_id IS NULL AND username IS NOT NULL;

UPDATE user_sync_state
SET user_id = (SELECT users.id FROM users WHERE users.username = user_sync_state.username)
WHERE user_id IS NULL AND username IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_likes_account_user_id ON content_likes(account_user_id);
CREATE INDEX IF NOT EXISTS idx_content_favorites_user_id ON content_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_account_user_id ON comments(account_user_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_follower_user_id ON user_follows(follower_user_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_following_user_id ON user_follows(following_user_id);
CREATE INDEX IF NOT EXISTS idx_user_practice_privacy_user_id ON user_practice_privacy(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_related_user_id ON notifications(related_user_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_user_id ON sync_log(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sync_state_user_id ON user_sync_state(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_likes_content_account_user_unique
  ON content_likes(content_id, account_user_id)
  WHERE account_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_favorites_content_user_unique
  ON content_favorites(content_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_follows_user_ids_unique
  ON user_follows(follower_user_id, following_user_id)
  WHERE follower_user_id IS NOT NULL AND following_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_practice_privacy_user_id_unique
  ON user_practice_privacy(user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sync_state_user_id_unique
  ON user_sync_state(user_id)
  WHERE user_id IS NOT NULL;
