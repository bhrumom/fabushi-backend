-- Managed D1 migration for internal-id / external-number layering.
-- users.id and meditation_groups.id remain the relational primary keys.
-- user_no / group_no become the externally surfaced stable numbers.

PRAGMA defer_foreign_keys = ON;

ALTER TABLE users ADD COLUMN user_no INTEGER;
UPDATE users
SET user_no = id
WHERE user_no IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_no ON users(user_no);

CREATE TRIGGER IF NOT EXISTS trg_users_assign_user_no
AFTER INSERT ON users
FOR EACH ROW
WHEN NEW.user_no IS NULL
BEGIN
  UPDATE users
  SET user_no = NEW.id
  WHERE id = NEW.id;
END;

ALTER TABLE meditation_groups ADD COLUMN group_no INTEGER;
UPDATE meditation_groups
SET group_no = id
WHERE group_no IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_meditation_groups_group_no ON meditation_groups(group_no);

CREATE TRIGGER IF NOT EXISTS trg_meditation_groups_assign_group_no
AFTER INSERT ON meditation_groups
FOR EACH ROW
WHEN NEW.group_no IS NULL
BEGIN
  UPDATE meditation_groups
  SET group_no = NEW.id
  WHERE id = NEW.id;
END;
