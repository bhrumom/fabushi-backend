-- =============================================================================
-- 全球法布施 - 数据库迁移脚本 v2 (安全版本)
-- =============================================================================
-- 迁移日期: 2025-12-19
-- 目的: 为现有表添加字段，创建新表
-- 注意：只修改已存在的表，创建不存在的新表
-- =============================================================================

-- 1. 为 users 表添加新字段（这些字段可能已存在，会报错但不影响后续执行）
ALTER TABLE users ADD COLUMN sync_version INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN extra_data TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;

-- 2. 为 content_likes 表添加字段
ALTER TABLE content_likes ADD COLUMN sync_version INTEGER DEFAULT 1;
ALTER TABLE content_likes ADD COLUMN username TEXT;

-- 3. 为 comments 表添加字段
ALTER TABLE comments ADD COLUMN sync_version INTEGER DEFAULT 1;
ALTER TABLE comments ADD COLUMN username TEXT;
ALTER TABLE comments ADD COLUMN content_title TEXT;

-- 4. 更新 content_metadata 表
ALTER TABLE content_metadata ADD COLUMN share_count INTEGER DEFAULT 0;
ALTER TABLE content_metadata ADD COLUMN updated_at TEXT;

-- =============================================================================
-- END OF STEP 1 MIGRATION (existing tables only)
-- =============================================================================
