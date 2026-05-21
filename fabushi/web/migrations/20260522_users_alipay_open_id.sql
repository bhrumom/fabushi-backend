-- Add the Alipay OAuth open_id column used by the mobile login callback.
-- Long-lived D1 databases already have alipay_user_id but were missing this
-- companion identifier, causing Alipay one-click registration to fail at INSERT.

ALTER TABLE users ADD COLUMN alipay_open_id TEXT;

CREATE INDEX IF NOT EXISTS idx_users_alipay_open_id ON users(alipay_open_id);
