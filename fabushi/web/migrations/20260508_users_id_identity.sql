-- Managed D1 migration for the user-id-first auth and mapping close-out.
-- Some long-lived D1 databases still have a legacy users table without users.id.
-- D1 applies migrations inside a transaction, so we cannot rely on toggling
-- foreign_keys off mid-flight. Rename the legacy tables first, rebuild the
-- users table, repopulate the child tables, then drop the legacy copies while
-- deferred foreign-key checks stay open until commit.

PRAGMA defer_foreign_keys = ON;

ALTER TABLE email_username_mapping RENAME TO email_username_mapping__legacy;
ALTER TABLE alipay_bindings RENAME TO alipay_bindings__legacy;
ALTER TABLE users RENAME TO users__legacy;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
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
  alipay_avatar TEXT,
  alipay_bound_at TEXT,
  phone_number TEXT,
  firebase_uid TEXT,
  apple_user_id TEXT,
  nickname TEXT,
  avatar TEXT,
  bio TEXT,
  main_practice_title TEXT,
  main_practice_file_path TEXT,
  main_practice_selected_at TEXT,
  total_transferred_bytes INTEGER DEFAULT 0,
  last_transfer_at TEXT,
  sync_version INTEGER DEFAULT 1,
  extra_data TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

INSERT INTO users (
  id,
  username,
  email,
  password_hash,
  salt,
  iterations,
  algo,
  email_verified,
  membership_type,
  membership_expires_at,
  free_trial_end_date,
  stripe_customer_id,
  subscription_id,
  wechat_openid,
  wechat_nickname,
  wechat_headimgurl,
  wechat_bound_at,
  alipay_user_id,
  alipay_nickname,
  alipay_avatar,
  alipay_bound_at,
  phone_number,
  firebase_uid,
  apple_user_id,
  nickname,
  avatar,
  bio,
  main_practice_title,
  main_practice_file_path,
  main_practice_selected_at,
  total_transferred_bytes,
  last_transfer_at,
  sync_version,
  extra_data,
  created_at,
  updated_at
)
SELECT
  rowid,
  username,
  email,
  password_hash,
  salt,
  iterations,
  algo,
  email_verified,
  membership_type,
  membership_expires_at,
  free_trial_end_date,
  stripe_customer_id,
  subscription_id,
  wechat_openid,
  wechat_nickname,
  wechat_headimgurl,
  wechat_bound_at,
  alipay_user_id,
  alipay_nickname,
  alipay_avatar,
  alipay_bound_at,
  phone_number,
  firebase_uid,
  apple_user_id,
  nickname,
  avatar,
  bio,
  main_practice_title,
  main_practice_file_path,
  main_practice_selected_at,
  total_transferred_bytes,
  last_transfer_at,
  sync_version,
  extra_data,
  created_at,
  updated_at
FROM users__legacy;

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_wechat_openid ON users(wechat_openid);
CREATE INDEX IF NOT EXISTS idx_users_alipay_user_id ON users(alipay_user_id);
CREATE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_users_apple_user_id ON users(apple_user_id);

CREATE TABLE email_username_mapping (
  email TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  user_id INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO email_username_mapping (email, username, user_id)
SELECT
  map.email,
  map.username,
  users.id
FROM email_username_mapping__legacy map
LEFT JOIN users ON users.username = map.username;

CREATE INDEX IF NOT EXISTS idx_email_username_mapping_user_id ON email_username_mapping(user_id);

CREATE TABLE alipay_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alipay_user_id TEXT UNIQUE NOT NULL,
  username TEXT,
  user_id INTEGER,
  bound_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO alipay_bindings (alipay_user_id, username, user_id, bound_at)
SELECT
  binding.alipay_user_id,
  binding.username,
  users.id,
  binding.bound_at
FROM alipay_bindings__legacy binding
LEFT JOIN users ON users.username = binding.username;

CREATE INDEX IF NOT EXISTS idx_alipay_bindings_user_id ON alipay_bindings(user_id);

DROP TABLE email_username_mapping__legacy;
DROP TABLE alipay_bindings__legacy;
DROP TABLE users__legacy;
