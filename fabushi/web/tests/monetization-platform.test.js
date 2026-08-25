import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { route } from '../src/router.js';
import {
  adBillableAmount,
  allocateTwoPartySplit,
  assertIdentifier,
  createPayCheckout,
  normalizeCurrency,
  validateTwoPartySplit,
} from '../src/services/monetization-platform.js';

const workspace = process.env.GITHUB_WORKSPACE
  ? resolve(process.env.GITHUB_WORKSPACE)
  : resolve(new URL('../../..', import.meta.url).pathname);
const migrations = join(workspace, 'third_party/mahayana/mahayana-rs/mahayana-platform-worker/migrations');

function runSqlite(database, sql) {
  execFileSync('sqlite3', [database], { input: sql, stdio: ['pipe', 'inherit', 'inherit'] });
}

test('two-party split is integer-safe and conserves every minor unit', () => {
  const split = allocateTwoPartySplit(101, { platformBps: 3000, developerBps: 7000 });
  assert.equal(split.platformAmount, 30);
  assert.equal(split.developerAmount, 71);
  assert.equal(split.platformAmount + split.developerAmount, 101);
  assert.throws(() => validateTwoPartySplit({ platformBps: 3000, developerBps: 6999 }), /10000/);
});

test('advertising billing supports CPM CPC CPA and rewarded without client supplied prices', () => {
  assert.equal(adBillableAmount({ billing_model: 'cpm', bid_amount: 2000 }, 'impression', 1), 2);
  assert.equal(adBillableAmount({ billing_model: 'cpm', bid_amount: 2000 }, 'click', 1), 0);
  assert.equal(adBillableAmount({ billing_model: 'cpc', bid_amount: 50 }, 'click', 3), 150);
  assert.equal(adBillableAmount({ billing_model: 'cpa', bid_amount: 900 }, 'conversion', 2), 1800);
  assert.equal(adBillableAmount({ billing_model: 'rewarded', bid_amount: 25 }, 'rewarded', 4), 100);
});

test('identifiers, currency and payment rails are validated before forwarding', async () => {
  assert.equal(assertIdentifier('miniapp:global-1'), 'miniapp:global-1');
  assert.equal(normalizeCurrency('cny'), 'CNY');
  await assert.rejects(
    createPayCheckout(
      { FABUSHI_PAY_URL: 'http://pay.invalid' },
      'Bearer example',
      { miniAppId: 'miniapp', sku: 'monthly', rail: 'web_provider', idempotencyKey: 'idempotent-1' },
    ),
    /HTTPS/,
  );
});

test('unified monetization routes are registered behind authentication', async () => {
  const response = await route(
    new Request('https://api.ombhrum.com/api/monetization/developer/summary'),
    {},
    {},
    {},
  );
  assert.equal(response.status, 401);
});

test('canonical monetization schema extends the existing Rust ledger instead of creating a mutable balance table', () => {
  const migrationPath = join(migrations, '0008_monetization_platform.sql');
  assert.ok(existsSync(migrationPath));
  const sql = readFileSync(migrationPath, 'utf8');
  for (const table of [
    'monetization_developer_profiles',
    'monetization_split_rules',
    'monetization_revenue_events',
    'monetization_subscriptions',
    'monetization_provider_events',
    'monetization_ad_campaigns',
    'monetization_ad_placements',
    'monetization_ad_events',
    'monetization_payout_requests',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /wallet_balances/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS monetization_balances/);
});

test('canonical platform payment plus monetization migrations apply cleanly in SQLite', { skip: !existsSync('/usr/bin/sqlite3') && !existsSync('/bin/sqlite3') }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'fabushi-monetization-'));
  const database = join(directory, 'schema.db');
  for (const name of ['0001_platform.sql', '0007_fabushi_pay.sql', '0008_monetization_platform.sql']) {
    runSqlite(database, readFileSync(join(migrations, name), 'utf8'));
  }
  const tables = execFileSync('sqlite3', [database, ".tables"], { encoding: 'utf8' });
  assert.match(tables, /monetization_revenue_events/);
  assert.match(tables, /developer_payouts/);
  assert.match(tables, /journal_entries/);
});
