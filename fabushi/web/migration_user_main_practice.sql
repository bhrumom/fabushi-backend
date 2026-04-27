-- =============================================================================
-- 迁移脚本：为 users 表添加账号级主修功课字段
-- 用途：让禅室主修功课随账号保存在云端，切换账号时读取对应用户数据
-- =============================================================================

ALTER TABLE users ADD COLUMN main_practice_title TEXT;
ALTER TABLE users ADD COLUMN main_practice_file_path TEXT;
ALTER TABLE users ADD COLUMN main_practice_selected_at TEXT;

-- =============================================================================
-- 执行方式：
-- wrangler d1 execute <DATABASE_NAME> --file=web/migration_user_main_practice.sql
--
-- 迁移完成后可验证：
-- wrangler d1 execute <DATABASE_NAME> --command="PRAGMA table_info(users);"
-- =============================================================================
