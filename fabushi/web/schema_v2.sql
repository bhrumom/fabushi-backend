-- =============================================================================
-- 全球法布施 - 统一数据库 Schema v2
-- =============================================================================
-- 创建日期: 2025-12-19
-- 设计原则:
--   1. 单一数据源 - 云端D1为主，本地仅缓存
--   2. 统一标识符 - 所有内容使用 content_id (file_path)
--   3. 版本控制 - sync_version 用于增量同步与冲突检测
--   4. 可扩展性 - extra_data JSON 字段存储未来扩展
--   5. 运行时身份统一以 users.id 为准，username 仅保留兼容/展示用途
-- =============================================================================

-- =============================================================================
-- 1. 用户系统
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT,
  salt TEXT,
  iterations INTEGER,
  algo TEXT,
  email_verified INTEGER DEFAULT 0,
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
  nickname TEXT,
  avatar TEXT,
  bio TEXT,
  main_practice_title TEXT,
  main_practice_file_path TEXT,
  main_practice_selected_at TEXT,
  membership_type TEXT DEFAULT 'expired',
  membership_expires_at TEXT,
  free_trial_end_date TEXT,
  stripe_customer_id TEXT,
  subscription_id TEXT,
  total_transferred_bytes INTEGER DEFAULT 0,
  last_transfer_at TEXT,
  sync_version INTEGER DEFAULT 1,
  extra_data TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_alipay_user_id ON users(alipay_user_id);
CREATE INDEX IF NOT EXISTS idx_users_wechat_openid ON users(wechat_openid);
CREATE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_users_apple_user_id ON users(apple_user_id);
CREATE INDEX IF NOT EXISTS idx_users_sync_version ON users(sync_version);

CREATE TABLE IF NOT EXISTS email_username_mapping (
  email TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  user_id INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_username_mapping_user_id ON email_username_mapping(user_id);

CREATE TABLE IF NOT EXISTS alipay_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alipay_user_id TEXT UNIQUE NOT NULL,
  username TEXT,
  user_id INTEGER,
  bound_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alipay_bindings_user_id ON alipay_bindings(user_id);

-- =============================================================================
-- 2. 会员与支付系统
-- =============================================================================

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  username TEXT,
  account_user_id INTEGER,
  plan TEXT NOT NULL,
  amount TEXT NOT NULL,
  original_amount TEXT,
  currency TEXT DEFAULT 'CNY',
  status TEXT NOT NULL,
  platform TEXT,
  trade_no TEXT,
  is_admin_order INTEGER DEFAULT 0,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_orders_username ON orders(username);
CREATE INDEX IF NOT EXISTS idx_orders_account_user_id ON orders(account_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

CREATE TABLE IF NOT EXISTS purchase_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  user_id INTEGER,
  order_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT DEFAULT 'CNY',
  status TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  purchased_at TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_purchase_history_username ON purchase_history(username);
CREATE INDEX IF NOT EXISTS idx_purchase_history_user_id ON purchase_history(user_id);

CREATE TABLE IF NOT EXISTS redeem_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS redeem_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  user_id INTEGER,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  days INTEGER NOT NULL,
  redeemed_at TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  previous_expiry_date TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_redeem_history_username ON redeem_history(username);
CREATE INDEX IF NOT EXISTS idx_redeem_history_user_id ON redeem_history(user_id);

CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  user_id INTEGER,
  type TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memberships_username ON memberships(username);
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);

-- =============================================================================
-- 3. 内容互动系统
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id TEXT UNIQUE NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  title TEXT,
  file_path TEXT,
  category TEXT,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_content_metadata_content_id ON content_metadata(content_id);
CREATE INDEX IF NOT EXISTS idx_content_metadata_file_path ON content_metadata(file_path);
CREATE INDEX IF NOT EXISTS idx_content_metadata_category ON content_metadata(category);
CREATE INDEX IF NOT EXISTS idx_content_metadata_hot ON content_metadata(like_count DESC, comment_count DESC);

CREATE TABLE IF NOT EXISTS content_likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  username TEXT,
  account_user_id INTEGER,
  title TEXT,
  file_path TEXT,
  created_at TEXT NOT NULL,
  sync_version INTEGER DEFAULT 1,
  UNIQUE(content_id, account_user_id),
  FOREIGN KEY (account_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_content_likes_content_id ON content_likes(content_id);
CREATE INDEX IF NOT EXISTS idx_content_likes_username ON content_likes(username);
CREATE INDEX IF NOT EXISTS idx_content_likes_account_user_id ON content_likes(account_user_id);
CREATE INDEX IF NOT EXISTS idx_content_likes_sync_version ON content_likes(sync_version);

CREATE TABLE IF NOT EXISTS content_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  username TEXT,
  user_id INTEGER,
  title TEXT,
  file_path TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  sync_version INTEGER DEFAULT 1,
  UNIQUE(content_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_favorites_content_id ON content_favorites(content_id);
CREATE INDEX IF NOT EXISTS idx_content_favorites_username ON content_favorites(username);
CREATE INDEX IF NOT EXISTS idx_content_favorites_user_id ON content_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_content_favorites_sync_version ON content_favorites(sync_version);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id TEXT NOT NULL,
  username TEXT,
  account_user_id INTEGER,
  content TEXT NOT NULL,
  parent_id INTEGER,
  tag TEXT,
  content_title TEXT,
  main_practice TEXT,
  like_count INTEGER DEFAULT 0,
  sync_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  FOREIGN KEY (account_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comments_content_id ON comments(content_id);
CREATE INDEX IF NOT EXISTS idx_comments_username ON comments(username);
CREATE INDEX IF NOT EXISTS idx_comments_account_user_id ON comments(account_user_id);
CREATE INDEX IF NOT EXISTS idx_comments_tag ON comments(tag);
CREATE INDEX IF NOT EXISTS idx_comments_sync_version ON comments(sync_version);
CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at DESC);

-- =============================================================================
-- 4. 修行记录系统
-- =============================================================================

CREATE TABLE IF NOT EXISTS meditation_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  user_id INTEGER,
  sutra_name TEXT NOT NULL,
  sutra_source TEXT DEFAULT 'custom',
  duration INTEGER DEFAULT 0,
  chant_count INTEGER DEFAULT 0,
  record_date TEXT NOT NULL,
  local_time TEXT,
  timezone_offset_minutes INTEGER,
  start_time TEXT,
  end_time TEXT,
  is_manual INTEGER DEFAULT 0,
  notes TEXT,
  sync_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meditation_records_username ON meditation_records(username);
CREATE INDEX IF NOT EXISTS idx_meditation_records_user_id ON meditation_records(user_id);
CREATE INDEX IF NOT EXISTS idx_meditation_records_date ON meditation_records(record_date);
CREATE INDEX IF NOT EXISTS idx_meditation_records_sync_version ON meditation_records(sync_version);

CREATE TABLE IF NOT EXISTS meditation_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  user_id INTEGER,
  sutra_name TEXT NOT NULL,
  target_count INTEGER NOT NULL,
  current_count INTEGER DEFAULT 0,
  dedication TEXT,
  status TEXT DEFAULT 'active',
  sync_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meditation_goals_username ON meditation_goals(username);
CREATE INDEX IF NOT EXISTS idx_meditation_goals_user_id ON meditation_goals(user_id);
CREATE INDEX IF NOT EXISTS idx_meditation_goals_status ON meditation_goals(status);
CREATE INDEX IF NOT EXISTS idx_meditation_goals_sync_version ON meditation_goals(sync_version);

CREATE TABLE IF NOT EXISTS meditation_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  owner_username TEXT,
  owner_user_id INTEGER,
  require_approval INTEGER DEFAULT 0,
  daily_goal_minutes INTEGER DEFAULT 30,
  cumulative_miss_limit INTEGER DEFAULT 7,
  consecutive_miss_limit INTEGER DEFAULT 3,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meditation_groups_owner ON meditation_groups(owner_username);
CREATE INDEX IF NOT EXISTS idx_meditation_groups_owner_user_id ON meditation_groups(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_meditation_groups_name ON meditation_groups(name);

CREATE TABLE IF NOT EXISTS meditation_group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  username TEXT,
  user_id INTEGER,
  role TEXT DEFAULT 'member',
  status TEXT DEFAULT 'pending',
  joined_at TEXT,
  updated_at TEXT,
  cumulative_missed_days INTEGER DEFAULT 0,
  consecutive_missed_days INTEGER DEFAULT 0,
  warning_message TEXT,
  removed_at TEXT,
  removal_reason TEXT,
  UNIQUE(group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES meditation_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meditation_group_members_group ON meditation_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_meditation_group_members_username ON meditation_group_members(username);
CREATE INDEX IF NOT EXISTS idx_meditation_group_members_user_id ON meditation_group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_meditation_group_members_status ON meditation_group_members(status);

CREATE TABLE IF NOT EXISTS meditation_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  user_id INTEGER UNIQUE,
  default_sutra TEXT,
  default_duration INTEGER DEFAULT 30,
  reminder_enabled INTEGER DEFAULT 0,
  reminder_time TEXT,
  sync_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meditation_settings_user_id ON meditation_settings(user_id);

-- =============================================================================
-- 5. 社交系统
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_username TEXT,
  following_username TEXT,
  follower_user_id INTEGER,
  following_user_id INTEGER,
  sync_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(follower_user_id, following_user_id),
  FOREIGN KEY (follower_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (following_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_username);
CREATE INDEX IF NOT EXISTS idx_user_follows_following ON user_follows(following_username);
CREATE INDEX IF NOT EXISTS idx_user_follows_follower_user_id ON user_follows(follower_user_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_following_user_id ON user_follows(following_user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  user_id INTEGER,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  related_content_id TEXT,
  related_username TEXT,
  related_user_id INTEGER,
  is_read INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (related_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_username ON notifications(username);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

-- =============================================================================
-- 6. 同步系统
-- =============================================================================

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  user_id INTEGER,
  table_name TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  sync_version INTEGER NOT NULL,
  data_snapshot TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_log_username ON sync_log(username);
CREATE INDEX IF NOT EXISTS idx_sync_log_user_id ON sync_log(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_sync_version ON sync_log(sync_version);
CREATE INDEX IF NOT EXISTS idx_sync_log_table_name ON sync_log(table_name);

CREATE TABLE IF NOT EXISTS user_sync_state (
  username TEXT PRIMARY KEY,
  user_id INTEGER UNIQUE,
  last_sync_version INTEGER DEFAULT 0,
  last_sync_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sync_state_user_id ON user_sync_state(user_id);

-- =============================================================================
-- 7. 内容搜索系统
-- =============================================================================

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

CREATE VIRTUAL TABLE IF NOT EXISTS text_contents_fts USING fts5(
  title,
  content,
  content='text_contents',
  content_rowid='id'
);

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
