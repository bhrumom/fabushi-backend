-- Managed D1 migration for the profile username-rename flow.
-- `stripe_customer_id` and `subscription_id` already exist in schema.sql/schema_v2.sql
-- and are referenced by the live profile handler plus release-gate E2E tests, so
-- the release-managed migration must add them for existing databases too.

ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN subscription_id TEXT;
