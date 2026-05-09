-- Upgrade external display numbers to non-enumerable random short numbers.
-- Internal relational ids remain separate and are not exposed as user_no/group_no.
--
-- Application code supplies CSPRNG values first. These triggers are only a
-- database safety net for legacy/direct inserts that omit the external number.

DROP TRIGGER IF EXISTS trg_users_assign_user_no;
DROP TRIGGER IF EXISTS trg_meditation_groups_assign_group_no;

CREATE TRIGGER IF NOT EXISTS trg_users_assign_user_no
AFTER INSERT ON users
FOR EACH ROW
WHEN NEW.user_no IS NULL
BEGIN
  UPDATE users
  SET user_no = 100000000 + ABS(RANDOM() % 900000000)
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_meditation_groups_assign_group_no
AFTER INSERT ON meditation_groups
FOR EACH ROW
WHEN NEW.group_no IS NULL
BEGIN
  UPDATE meditation_groups
  SET group_no = 10000000 + ABS(RANDOM() % 90000000)
  WHERE id = NEW.id;
END;
