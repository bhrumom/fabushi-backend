-- Add stable user-id columns for co-practice groups.
-- `username` remains for display and backward compatibility, but group identity
-- should be resolved through users.id when available.

ALTER TABLE meditation_groups ADD COLUMN owner_user_id INTEGER;
ALTER TABLE meditation_group_members ADD COLUMN user_id INTEGER;

UPDATE meditation_groups
SET owner_user_id = (
  SELECT id FROM users WHERE users.username = meditation_groups.owner_username
)
WHERE owner_user_id IS NULL AND owner_username IS NOT NULL;

UPDATE meditation_group_members
SET user_id = (
  SELECT id FROM users WHERE users.username = meditation_group_members.username
)
WHERE user_id IS NULL AND username IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_meditation_groups_owner_user_id
  ON meditation_groups(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_meditation_group_members_user_id
  ON meditation_group_members(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meditation_group_members_group_user_id_unique
  ON meditation_group_members(group_id, user_id)
  WHERE user_id IS NOT NULL;
