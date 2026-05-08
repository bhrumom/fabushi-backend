-- Managed D1 migration for the profile username-rename flow.
-- `free_trial_end_date` already exists in schema.sql/schema_v2.sql and is
-- referenced by the live profile handler plus release-gate E2E tests, so the
-- release-managed migration must add it for existing databases too.

ALTER TABLE users ADD COLUMN free_trial_end_date TEXT;
