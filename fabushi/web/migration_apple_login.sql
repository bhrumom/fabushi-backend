-- 迁移：添加 apple_user_id 列用于 Sign in with Apple 登录
-- 日期: 2026-03-25
-- 说明: 支持 App Store Guideline 4.8 要求的 Apple 登录
-- 注意: SQLite 不支持 ALTER TABLE ADD COLUMN UNIQUE，需通过 UNIQUE INDEX 实现

ALTER TABLE users ADD COLUMN apple_user_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_user_id ON users(apple_user_id);
