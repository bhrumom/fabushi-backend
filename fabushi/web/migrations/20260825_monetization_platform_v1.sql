-- Fabushi Monetization Platform v1
-- Immutable money movements are recorded in monetization_journals + monetization_entries.
-- Amounts are integer minor units (fen/cents) to avoid floating point money arithmetic.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS monetization_accounts (
  account_id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_type, owner_id, bucket, currency)
);

CREATE TABLE IF NOT EXISTS monetization_revenue_events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_id TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  gross_amount_minor INTEGER NOT NULL CHECK(gross_amount_minor >= 0),
  currency TEXT NOT NULL,
  developer_id TEXT,
  miniapp_id TEXT,
  bot_id TEXT,
  customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'recorded',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monetization_split_rules (
  rule_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  revenue_source TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  rule_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(scope_type, scope_id, revenue_source, version)
);
CREATE INDEX IF NOT EXISTS idx_monetization_split_rules_active
  ON monetization_split_rules(scope_type, scope_id, revenue_source, status, effective_from);

CREATE TABLE IF NOT EXISTS monetization_journals (
  journal_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_debits_minor INTEGER NOT NULL CHECK(total_debits_minor >= 0),
  total_credits_minor INTEGER NOT NULL CHECK(total_credits_minor >= 0),
  status TEXT NOT NULL DEFAULT 'posted',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  CHECK(total_debits_minor = total_credits_minor),
  FOREIGN KEY(event_id) REFERENCES monetization_revenue_events(event_id)
);

CREATE TABLE IF NOT EXISTS monetization_entries (
  entry_id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('debit', 'credit')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(journal_id) REFERENCES monetization_journals(journal_id),
  FOREIGN KEY(account_id) REFERENCES monetization_accounts(account_id)
);
CREATE INDEX IF NOT EXISTS idx_monetization_entries_journal ON monetization_entries(journal_id);
CREATE INDEX IF NOT EXISTS idx_monetization_entries_account ON monetization_entries(account_id, created_at);

CREATE TABLE IF NOT EXISTS monetization_balances (
  account_id TEXT PRIMARY KEY,
  pending_minor INTEGER NOT NULL DEFAULT 0 CHECK(pending_minor >= 0),
  available_minor INTEGER NOT NULL DEFAULT 0 CHECK(available_minor >= 0),
  reserved_minor INTEGER NOT NULL DEFAULT 0 CHECK(reserved_minor >= 0),
  paid_minor INTEGER NOT NULL DEFAULT 0 CHECK(paid_minor >= 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES monetization_accounts(account_id)
);

CREATE TABLE IF NOT EXISTS monetization_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_subscription_id TEXT,
  status TEXT NOT NULL,
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_subscription_id)
);

CREATE TABLE IF NOT EXISTS monetization_entitlements (
  entitlement_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(subject_type, subject_id, capability, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_monetization_entitlements_subject
  ON monetization_entitlements(subject_type, subject_id, status, valid_to);

CREATE TABLE IF NOT EXISTS monetization_payouts (
  payout_id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_payout_id TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  failure_code TEXT,
  failure_message TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES monetization_accounts(account_id),
  UNIQUE(provider, provider_payout_id)
);

CREATE TABLE IF NOT EXISTS monetization_ad_events (
  ad_event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  placement_id TEXT NOT NULL,
  miniapp_id TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  campaign_id TEXT,
  event_type TEXT NOT NULL,
  billable_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(billable_amount_minor >= 0),
  currency TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
