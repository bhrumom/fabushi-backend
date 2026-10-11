ALTER TABLE human_call_channels
  ADD COLUMN membership_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS human_call_members (
  call_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('creator', 'member')),
  state TEXT NOT NULL CHECK (state IN ('active', 'left')),
  device_id TEXT,
  joined_generation INTEGER NOT NULL DEFAULT 0,
  left_generation INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (call_id, user_id),
  FOREIGN KEY (call_id) REFERENCES human_call_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_human_call_members_user_active
  ON human_call_members(user_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS human_call_member_mutations (
  call_id TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  actor_device_id TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  previous_revision INTEGER NOT NULL,
  new_revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
  target_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (call_id, actor_user_id, actor_device_id, client_mutation_id),
  FOREIGN KEY (call_id) REFERENCES human_call_channels(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO human_call_members (
  call_id, user_id, role, state, device_id, joined_generation,
  left_generation, created_at, updated_at
)
SELECT id, creator_user_id, 'creator', 'active', creator_device_id, 0,
  NULL, created_at, updated_at
FROM human_call_channels;

INSERT OR IGNORE INTO human_call_members (
  call_id, user_id, role, state, device_id, joined_generation,
  left_generation, created_at, updated_at
)
SELECT id, peer_user_id, 'member', 'active', peer_device_id, 0,
  NULL, created_at, updated_at
FROM human_call_channels;
