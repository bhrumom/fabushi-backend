-- D1数据库Schema
-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  algo TEXT NOT NULL,
  email_verified INTEGER DEFAULT 0,
  membership_type TEXT DEFAULT 'trial',
  membership_expires_at TEXT,
  free_trial_end_date TEXT,
  stripe_customer_id TEXT,
  subscription_id TEXT,
  wechat_openid TEXT,
  wechat_nickname TEXT,
  wechat_headimgurl TEXT,
  wechat_bound_at TEXT,
  alipay_user_id TEXT,
  alipay_nickname TEXT,
  alipay_bound_at TEXT,
  alipay_bound_at TEXT,
  total_transferred_bytes INTEGER DEFAULT 0,
  last_transfer_at TEXT,
  nickname TEXT,
  avatar TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- 评论表
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  parent_id INTEGER,
  like_count INTEGER DEFAULT 0
);

CREATE INDEX idx_comments_video_id ON comments(video_id);
CREATE INDEX idx_comments_user_id ON comments(user_id);

-- 注意: total_transferred_bytes 和 last_transfer_at 字段用于排行榜功能
-- 迁移日期: 2025-11-04

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_wechat_openid ON users(wechat_openid);
CREATE INDEX idx_users_alipay_user_id ON users(alipay_user_id);

-- 邮箱用户名映射表
CREATE TABLE IF NOT EXISTS email_username_mapping (
  email TEXT PRIMARY KEY,
  username TEXT NOT NULL
);

-- 订单表
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  amount TEXT NOT NULL,
  original_amount TEXT,
  is_admin_order INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  platform TEXT,
  trade_no TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_orders_order_id ON orders(order_id);
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);

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
  valid_to TEXT NOT NULL
);

CREATE INDEX idx_purchase_history_username ON purchase_history(username);
CREATE INDEX idx_purchase_history_order_id ON purchase_history(order_id);

-- 兑换码表
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

CREATE INDEX idx_redeem_codes_code ON redeem_codes(code);
CREATE INDEX idx_redeem_codes_used ON redeem_codes(used);

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
  previous_expiry_date TEXT
);

CREATE INDEX idx_redeem_history_username ON redeem_history(username);
CREATE INDEX idx_redeem_history_code ON redeem_history(code);

-- 会员记录表
CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  type TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_memberships_username ON memberships(username);

-- 文本内容表（搜索功能）
CREATE TABLE IF NOT EXISTS text_contents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  file_path TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_text_contents_title ON text_contents(title);
CREATE INDEX idx_text_contents_category ON text_contents(category);
CREATE INDEX idx_text_contents_file_path ON text_contents(file_path);

-- 全文搜索索引（使用FTS5虚拟表提升搜索性能）
CREATE VIRTUAL TABLE IF NOT EXISTS text_contents_fts USING fts5(
  title,
  content,
  content='text_contents',
  content_rowid='id'
);

-- FTS触发器：插入
CREATE TRIGGER IF NOT EXISTS text_contents_ai AFTER INSERT ON text_contents BEGIN
  INSERT INTO text_contents_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;

-- FTS触发器：删除
CREATE TRIGGER IF NOT EXISTS text_contents_ad AFTER DELETE ON text_contents BEGIN
  DELETE FROM text_contents_fts WHERE rowid = old.id;
END;

-- FTS触发器：更新
CREATE TRIGGER IF NOT EXISTS text_contents_au AFTER UPDATE ON text_contents BEGIN
  DELETE FROM text_contents_fts WHERE rowid = old.id;
  INSERT INTO text_contents_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;
