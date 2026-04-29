-- =============================================================================
-- 全球法布施 - 数据库迁移 Step 2 - 新表和索引
-- =============================================================================

-- 1. 创建关注关系表
CREATE TABLE IF NOT EXISTS user_follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_username TEXT NOT NULL,
  following_username TEXT NOT NULL,
  sync_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(follower_username, following_username)
);

CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_username);
CREATE INDEX IF NOT EXISTS idx_user_follows_following ON user_follows(following_username);

-- 2. 创建通知表
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  related_content_id TEXT,
  related_username TEXT,
  is_read INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_username ON notifications(username);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);

-- 3. 创建同步日志表
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  sync_version INTEGER NOT NULL,
  data_snapshot TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_log_username ON sync_log(username);
CREATE INDEX IF NOT EXISTS idx_sync_log_sync_version ON sync_log(sync_version);

-- 4. 创建用户同步状态表
CREATE TABLE IF NOT EXISTS user_sync_state (
  username TEXT PRIMARY KEY,
  last_sync_version INTEGER DEFAULT 0,
  last_sync_at TEXT
);

-- 5. 创建其他必要索引
CREATE INDEX IF NOT EXISTS idx_users_sync_version ON users(sync_version);
CREATE INDEX IF NOT EXISTS idx_content_likes_sync_version ON content_likes(sync_version);
CREATE INDEX IF NOT EXISTS idx_comments_sync_version ON comments(sync_version);

-- 6. 修行系统表（如果不存在则创建）
CREATE TABLE IF NOT EXISTS meditation_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
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
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meditation_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  sutra_name TEXT NOT NULL,
  target_count INTEGER NOT NULL,
  current_count INTEGER DEFAULT 0,
  dedication TEXT,
  status TEXT DEFAULT 'active',
  sync_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS meditation_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  default_sutra TEXT,
  default_duration INTEGER DEFAULT 30,
  reminder_enabled INTEGER DEFAULT 0,
  reminder_time TEXT,
  sync_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_meditation_records_username ON meditation_records(username);
CREATE INDEX IF NOT EXISTS idx_meditation_goals_username ON meditation_goals(username);

CREATE TABLE IF NOT EXISTS meditation_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  owner_username TEXT NOT NULL,
  require_approval INTEGER DEFAULT 0,
  daily_goal_minutes INTEGER DEFAULT 30,
  cumulative_miss_limit INTEGER DEFAULT 7,
  consecutive_miss_limit INTEGER DEFAULT 3,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS meditation_group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  status TEXT DEFAULT 'pending',
  joined_at TEXT,
  updated_at TEXT,
  cumulative_missed_days INTEGER DEFAULT 0,
  consecutive_missed_days INTEGER DEFAULT 0,
  warning_message TEXT,
  removed_at TEXT,
  removal_reason TEXT,
  UNIQUE(group_id, username)
);

CREATE INDEX IF NOT EXISTS idx_meditation_groups_owner ON meditation_groups(owner_username);
CREATE INDEX IF NOT EXISTS idx_meditation_group_members_group ON meditation_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_meditation_group_members_username ON meditation_group_members(username);
CREATE INDEX IF NOT EXISTS idx_meditation_group_members_status ON meditation_group_members(status);

-- =============================================================================
-- 数据迁移：复制 user_id 到 username 列
-- =============================================================================

-- 对于 content_likes 表
UPDATE content_likes SET username = user_id WHERE username IS NULL AND user_id IS NOT NULL;

-- 对于 comments 表  
UPDATE comments SET username = user_id WHERE username IS NULL AND user_id IS NOT NULL;

-- =============================================================================
-- END OF STEP 2 MIGRATION
-- =============================================================================
