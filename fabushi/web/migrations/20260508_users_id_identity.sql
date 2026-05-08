-- Managed D1 migration for the user-id-first auth and mapping close-out.
-- Keep legacy username columns for compatibility, but backfill canonical user ids
-- so fresh tokens, profile writes, and third-party bindings can move to users.id.

ALTER TABLE email_username_mapping ADD COLUMN user_id INTEGER;
UPDATE email_username_mapping
SET user_id = (
  SELECT id FROM users WHERE users.username = email_username_mapping.username
)
WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_username_mapping_user_id ON email_username_mapping(user_id);

ALTER TABLE alipay_bindings ADD COLUMN user_id INTEGER;
UPDATE alipay_bindings
SET user_id = (
  SELECT id FROM users WHERE users.username = alipay_bindings.username
)
WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_alipay_bindings_user_id ON alipay_bindings(user_id);
