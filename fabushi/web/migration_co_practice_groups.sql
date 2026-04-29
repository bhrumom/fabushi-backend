-- 共修小组与修行记录本地时分迁移
-- 如字段已存在，D1 会提示 duplicate column，可继续执行后续语句。

ALTER TABLE meditation_records ADD COLUMN local_time TEXT;
ALTER TABLE meditation_records ADD COLUMN timezone_offset_minutes INTEGER;
ALTER TABLE meditation_records ADD COLUMN start_time TEXT;
ALTER TABLE meditation_records ADD COLUMN end_time TEXT;

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
CREATE INDEX IF NOT EXISTS idx_meditation_groups_name ON meditation_groups(name);
CREATE INDEX IF NOT EXISTS idx_meditation_group_members_group ON meditation_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_meditation_group_members_username ON meditation_group_members(username);
CREATE INDEX IF NOT EXISTS idx_meditation_group_members_status ON meditation_group_members(status);
