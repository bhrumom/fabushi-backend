-- =============================================================================
-- 迁移脚本：为评论表添加 main_practice 字段
-- 用途：存储评论用户的主修功课，便于在评论显示时展示 @主修功课
-- =============================================================================

-- 添加 main_practice 列到 comments 表
ALTER TABLE comments ADD COLUMN main_practice TEXT;

-- 添加 video_id 和 user_id 别名列（如果尚未存在，用于向后兼容）
-- 注意：这些在 schema_v2.sql 中可能已经存在，添加前需检查
-- ALTER TABLE comments ADD COLUMN video_id TEXT;
-- ALTER TABLE comments ADD COLUMN user_id TEXT;

-- =============================================================================
-- 执行方式：
-- 1. 在 Cloudflare D1 控制台执行此 SQL
-- 2. 或通过 wrangler d1 execute <DATABASE_NAME> --file=migration_main_practice.sql
-- =============================================================================
