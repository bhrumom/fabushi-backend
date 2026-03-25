-- =============================================================================
-- 全球法布施 - 统一数据库 Schema v2
-- =============================================================================
-- 创建日期: 2025-12-19
-- 设计原则:
--   1. 单一数据源 - 云端D1为主，本地仅缓存
--   2. 统一标识符 - 所有内容使用 content_id (file_path)
--   3. 版本控制 - sync_version 用于增量同步与冲突检测
--   4. 可扩展性 - extra_data JSON 字段存储未来扩展
-- =============================================================================

-- 删除旧表（如有需要可选择性执行）
-- DROP TABLE IF EXISTS sync_log;
-- DROP TABLE IF EXISTS notifications;
-- DROP TABLE IF EXISTS user_follows;
-- DROP TABLE IF EXISTS meditation_settings;
-- DROP TABLE IF EXISTS meditation_goals;
-- DROP TABLE IF EXISTS meditation_records;
-- DROP TABLE IF EXISTS content_metadata;
-- DROP TABLE IF EXISTS content_likes;
-- DROP TABLE IF EXISTS comments;
-- DROP TABLE IF EXISTS redeem_history;
-- DROP TABLE IF EXISTS redeem_codes;
-- DROP TABLE IF EXISTS purchase_history;
-- DROP TABLE IF EXISTS orders;
-- DROP TABLE IF EXISTS memberships;
-- DROP TABLE IF EXISTS email_username_mapping;
-- DROP TABLE IF EXISTS users;

-- =============================================================================
-- 1. 用户系统
-- =============================================================================

-- 用户主表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- 核心身份
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  
  -- 密码认证（邮箱注册用户）
  password_hash TEXT,
  salt TEXT,
  iterations INTEGER,
  algo TEXT,
  email_verified INTEGER DEFAULT 0,
  
  -- 第三方认证
  alipay_user_id TEXT UNIQUE,
  alipay_nickname TEXT,
  alipay_avatar TEXT,
  alipay_bound_at TEXT,
  
  wechat_openid TEXT UNIQUE,
  wechat_nickname TEXT,
  wechat_headimgurl TEXT,
  wechat_bound_at TEXT,
  
  phone_number TEXT UNIQUE,
  firebase_uid TEXT UNIQUE,
  
  apple_user_id TEXT UNIQUE,
  
  -- 用户资料
  nickname TEXT,
  avatar TEXT,
  bio TEXT,
  
  -- 会员信息
  membership_type TEXT DEFAULT 'expired',  -- 'trial', 'paid', 'expired'
  membership_expires_at TEXT,
  free_trial_end_date TEXT,
  
  -- 支付信息
  stripe_customer_id TEXT,
  subscription_id TEXT,
  
  -- 统计数据
  total_transferred_bytes INTEGER DEFAULT 0,
  last_transfer_at TEXT,
  
  -- 同步与扩展
  sync_version INTEGER DEFAULT 1,
  extra_data TEXT,  -- JSON格式，存储未来扩展字段
  
  -- 时间戳
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- 用户表索引
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_alipay_user_id ON users(alipay_user_id);
CREATE INDEX IF NOT EXISTS idx_users_wechat_openid ON users(wechat_openid);
CREATE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_users_apple_user_id ON users(apple_user_id);
CREATE INDEX IF NOT EXISTS idx_users_sync_version ON users(sync_version);

-- 邮箱用户名映射（快速查找）
CREATE TABLE IF NOT EXISTS email_username_mapping (
  email TEXT PRIMARY KEY,
  username TEXT NOT NULL
);

-- =============================================================================
-- 2. 会员与支付系统
-- =============================================================================

-- 订单表
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  plan TEXT NOT NULL,  -- 'monthly', 'quarterly', 'yearly'
  amount TEXT NOT NULL,
  original_amount TEXT,
  currency TEXT DEFAULT 'CNY',
  status TEXT NOT NULL,  -- 'pending', 'completed', 'failed', 'refunded'
  platform TEXT,  -- 'alipay', 'wechat', 'stripe'
  trade_no TEXT,
  is_admin_order INTEGER DEFAULT 0,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_orders_username ON orders(username);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

-- 购买记录表
CREATE TABLE IF NOT EXISTS purchase_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  order_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT DEFAULT 'CNY',
  status TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  purchased_at TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_purchase_history_username ON purchase_history(username);

-- 兑换码表
CREATE TABLE IF NOT EXISTS redeem_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,  -- 'trial', 'premium'
  days INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  used_by TEXT,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_redeem_codes_code ON redeem_codes(code);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_used ON redeem_codes(used);

-- 兑换记录表
CREATE TABLE IF NOT EXISTS redeem_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  days INTEGER NOT NULL,
  redeemed_at TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  previous_expiry_date TEXT,
  
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_redeem_history_username ON redeem_history(username);

-- =============================================================================
-- 3. 内容互动系统（统一使用 content_id）
-- =============================================================================

-- 内容元数据表（统一管理所有内容的统计数据）
CREATE TABLE IF NOT EXISTS content_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id TEXT UNIQUE NOT NULL,      -- 统一标识符，使用 file_path
  content_type TEXT NOT NULL DEFAULT 'text',
  title TEXT,
  file_path TEXT,
  category TEXT,
  
  -- 统计计数（冗余存储，提高查询效率）
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_content_metadata_content_id ON content_metadata(content_id);
CREATE INDEX IF NOT EXISTS idx_content_metadata_file_path ON content_metadata(file_path);
CREATE INDEX IF NOT EXISTS idx_content_metadata_category ON content_metadata(category);
-- 热门内容查询优化索引
CREATE INDEX IF NOT EXISTS idx_content_metadata_hot ON content_metadata(like_count DESC, comment_count DESC);

-- 点赞表
CREATE TABLE IF NOT EXISTS content_likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  username TEXT,  -- NULL 表示游客点赞
  title TEXT,
  file_path TEXT,
  created_at TEXT NOT NULL,
  
  -- 同步字段
  sync_version INTEGER DEFAULT 1,
  
  UNIQUE(content_id, username),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_content_likes_content_id ON content_likes(content_id);
CREATE INDEX IF NOT EXISTS idx_content_likes_username ON content_likes(username);
CREATE INDEX IF NOT EXISTS idx_content_likes_sync_version ON content_likes(sync_version);

-- 收藏表
CREATE TABLE IF NOT EXISTS content_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  username TEXT NOT NULL,
  title TEXT,
  file_path TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  
  -- 同步字段
  sync_version INTEGER DEFAULT 1,
  
  UNIQUE(content_id, username),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_favorites_content_id ON content_favorites(content_id);
CREATE INDEX IF NOT EXISTS idx_content_favorites_username ON content_favorites(username);
CREATE INDEX IF NOT EXISTS idx_content_favorites_sync_version ON content_favorites(sync_version);

-- 评论表
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id TEXT NOT NULL,  -- 统一使用 content_id，替代原来的 video_id
  username TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_id INTEGER,
  
  -- 评论类型与标签
  tag TEXT,  -- 'ganying', 'fayuan', NULL
  content_title TEXT,  -- 关联内容的标题
  main_practice TEXT,  -- 评论用户的主修功课
  
  -- 统计
  like_count INTEGER DEFAULT 0,
  
  -- 同步字段
  sync_version INTEGER DEFAULT 1,
  
  created_at TEXT NOT NULL,
  updated_at TEXT,
  
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comments_content_id ON comments(content_id);
CREATE INDEX IF NOT EXISTS idx_comments_username ON comments(username);
CREATE INDEX IF NOT EXISTS idx_comments_tag ON comments(tag);
CREATE INDEX IF NOT EXISTS idx_comments_sync_version ON comments(sync_version);
CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at DESC);

-- =============================================================================
-- 4. 修行记录系统
-- =============================================================================

-- 修行记录表
CREATE TABLE IF NOT EXISTS meditation_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  sutra_name TEXT NOT NULL,
  sutra_source TEXT DEFAULT 'custom',  -- 'asset', 'custom'
  duration INTEGER DEFAULT 0,  -- 分钟
  chant_count INTEGER DEFAULT 0,  -- 遍数
  record_date TEXT NOT NULL,  -- YYYY-MM-DD
  is_manual INTEGER DEFAULT 0,  -- 0-实时, 1-补录
  notes TEXT,
  
  -- 同步字段
  sync_version INTEGER DEFAULT 1,
  
  created_at TEXT NOT NULL,
  
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meditation_records_username ON meditation_records(username);
CREATE INDEX IF NOT EXISTS idx_meditation_records_date ON meditation_records(record_date);
CREATE INDEX IF NOT EXISTS idx_meditation_records_sync_version ON meditation_records(sync_version);

-- 修行目标/发愿表
CREATE TABLE IF NOT EXISTS meditation_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  sutra_name TEXT NOT NULL,
  target_count INTEGER NOT NULL,
  current_count INTEGER DEFAULT 0,
  dedication TEXT,
  status TEXT DEFAULT 'active',  -- 'active', 'completed', 'abandoned'
  
  -- 同步字段
  sync_version INTEGER DEFAULT 1,
  
  created_at TEXT NOT NULL,
  updated_at TEXT,
  completed_at TEXT,
  
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meditation_goals_username ON meditation_goals(username);
CREATE INDEX IF NOT EXISTS idx_meditation_goals_status ON meditation_goals(status);
CREATE INDEX IF NOT EXISTS idx_meditation_goals_sync_version ON meditation_goals(sync_version);

-- 修行设置表
CREATE TABLE IF NOT EXISTS meditation_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  default_sutra TEXT,
  default_duration INTEGER DEFAULT 30,
  reminder_enabled INTEGER DEFAULT 0,
  reminder_time TEXT,
  
  -- 同步字段
  sync_version INTEGER DEFAULT 1,
  
  created_at TEXT NOT NULL,
  updated_at TEXT,
  
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- =============================================================================
-- 5. 社交系统
-- =============================================================================

-- 关注关系表
CREATE TABLE IF NOT EXISTS user_follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_username TEXT NOT NULL,
  following_username TEXT NOT NULL,
  
  -- 同步字段
  sync_version INTEGER DEFAULT 1,
  
  created_at TEXT NOT NULL,
  
  UNIQUE(follower_username, following_username),
  FOREIGN KEY (follower_username) REFERENCES users(username) ON DELETE CASCADE,
  FOREIGN KEY (following_username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_username);
CREATE INDEX IF NOT EXISTS idx_user_follows_following ON user_follows(following_username);

-- 通知表
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'like', 'comment', 'follow', 'system', 'meditation'
  
  -- 通知内容（JSON格式，灵活存储不同类型的数据）
  content TEXT NOT NULL,
  
  -- 关联
  related_content_id TEXT,
  related_username TEXT,
  
  is_read INTEGER DEFAULT 0,
  
  created_at TEXT NOT NULL,
  
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_username ON notifications(username);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

-- =============================================================================
-- 6. 同步系统
-- =============================================================================

-- 同步日志表（记录所有数据变更，用于增量同步）
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  table_name TEXT NOT NULL,  -- 'content_likes', 'comments', 'meditation_records', etc.
  record_id INTEGER NOT NULL,
  action TEXT NOT NULL,  -- 'insert', 'update', 'delete'
  sync_version INTEGER NOT NULL,
  data_snapshot TEXT,  -- JSON格式，记录变更时的数据快照
  created_at TEXT NOT NULL,
  
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_log_username ON sync_log(username);
CREATE INDEX IF NOT EXISTS idx_sync_log_sync_version ON sync_log(sync_version);
CREATE INDEX IF NOT EXISTS idx_sync_log_table_name ON sync_log(table_name);

-- 全局同步版本表（每个用户的最新同步版本）
CREATE TABLE IF NOT EXISTS user_sync_state (
  username TEXT PRIMARY KEY,
  last_sync_version INTEGER DEFAULT 0,
  last_sync_at TEXT,
  
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- =============================================================================
-- 7. 内容搜索系统
-- =============================================================================

-- 文本内容表
CREATE TABLE IF NOT EXISTS text_contents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  file_path TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_text_contents_title ON text_contents(title);
CREATE INDEX IF NOT EXISTS idx_text_contents_category ON text_contents(category);
CREATE INDEX IF NOT EXISTS idx_text_contents_file_path ON text_contents(file_path);

-- 全文搜索索引（FTS5）
CREATE VIRTUAL TABLE IF NOT EXISTS text_contents_fts USING fts5(
  title,
  content,
  content='text_contents',
  content_rowid='id'
);

-- FTS 触发器
CREATE TRIGGER IF NOT EXISTS text_contents_ai AFTER INSERT ON text_contents BEGIN
  INSERT INTO text_contents_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS text_contents_ad AFTER DELETE ON text_contents BEGIN
  DELETE FROM text_contents_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS text_contents_au AFTER UPDATE ON text_contents BEGIN
  DELETE FROM text_contents_fts WHERE rowid = old.id;
  INSERT INTO text_contents_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;

-- =============================================================================
-- 8. 触发器：自动维护计数与同步版本
-- =============================================================================

-- 点赞时更新 content_metadata 的 like_count
CREATE TRIGGER IF NOT EXISTS trg_likes_insert AFTER INSERT ON content_likes BEGIN
  INSERT INTO content_metadata (content_id, content_type, title, file_path, like_count)
  VALUES (NEW.content_id, NEW.content_type, NEW.title, NEW.file_path, 1)
  ON CONFLICT(content_id) DO UPDATE SET 
    like_count = like_count + 1,
    title = COALESCE(excluded.title, title),
    file_path = COALESCE(excluded.file_path, file_path),
    updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_likes_delete AFTER DELETE ON content_likes BEGIN
  UPDATE content_metadata 
  SET like_count = MAX(0, like_count - 1), updated_at = CURRENT_TIMESTAMP
  WHERE content_id = OLD.content_id;
END;

-- 评论时更新 content_metadata 的 comment_count
CREATE TRIGGER IF NOT EXISTS trg_comments_insert AFTER INSERT ON comments BEGIN
  INSERT INTO content_metadata (content_id, content_type, title, comment_count)
  VALUES (NEW.content_id, 'text', NEW.content_title, 1)
  ON CONFLICT(content_id) DO UPDATE SET 
    comment_count = comment_count + 1,
    title = COALESCE(excluded.title, title),
    updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_comments_delete AFTER DELETE ON comments BEGIN
  UPDATE content_metadata 
  SET comment_count = MAX(0, comment_count - 1), updated_at = CURRENT_TIMESTAMP
  WHERE content_id = OLD.content_id;
END;

-- =============================================================================
-- END OF SCHEMA
-- =============================================================================
