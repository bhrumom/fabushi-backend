import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const workspace = process.env.GITHUB_WORKSPACE
  ? resolve(process.env.GITHUB_WORKSPACE)
  : resolve(new URL('../../..', import.meta.url).pathname);
const payDir = join(
  workspace,
  'third_party/mahayana/mahayana-rs/mahayana-pay-worker',
);
const paymentApi = join(
  workspace,
  'third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/payment_api.rs',
);
const migrationsDir = join(
  workspace,
  'third_party/mahayana/mahayana-rs/mahayana-platform-worker/migrations',
);

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: workspace,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
}

function hydratePaymentSparseCheckout() {
  if (!process.env.GITHUB_ACTIONS) return;
  run('git', [
    'sparse-checkout',
    'set',
    '--no-cone',
    '/.github/scripts/**',
    '/fabushi/web/**',
    '/frontend/**',
    '/third_party/mahayana/mahayana-rs/mahayana-platform-worker/**',
    '/third_party/mahayana/mahayana-rs/mahayana-pay-worker/**',
  ]);
}

test('Fabushi Pay owns price, ledger, provider, and settlement boundaries', () => {
  hydratePaymentSparseCheckout();
  assert.ok(existsSync(join(payDir, 'Cargo.toml')), 'standalone pay Worker is required');
  assert.ok(existsSync(paymentApi), 'Rust payment service implementation is required');
  const migration = readFileSync(join(migrationsDir, '0007_fabushi_pay.sql'), 'utf8');
  const api = readFileSync(paymentApi, 'utf8');
  const worker = readFileSync(join(payDir, 'src/lib.rs'), 'utf8');

  for (const table of [
    'payment_product_config',
    'payment_intents',
    'payment_webhook_events',
    'fabushi_payment_refunds',
    'payment_disputes',
    'developer_settlement_releases',
    'developer_payouts',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /fabushi_pay_balance_enforced_by_worker_batch/);
  assert.match(migration, /UNIQUE \(user_id, idempotency_key\)/);
  assert.match(api, /api\.storekit\.apple\.com/);
  assert.match(api, /androidpublisher\.googleapis\.com/);
  assert.match(api, /FABUSHI_PAY_WEBHOOK_SECRET/);
  assert.match(api, /developer-pending:/);
  assert.match(api, /developer-available:/);
  assert.match(worker, /commerce\.purchase/);
  assert.doesNotMatch(api, /sk_live_|whsec_|AIza[0-9A-Za-z_-]{20,}/);
});

test('Fabushi Pay Rust Worker compiles for Cloudflare wasm32 in canonical CI', {
  skip: process.env.GITHUB_WORKFLOW !== 'CI',
}, () => {
  hydratePaymentSparseCheckout();

  run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
  run('cargo', [
    'test',
    '--manifest-path',
    join(payDir, 'Cargo.toml'),
  ]);
  run('cargo', [
    'clippy',
    '--manifest-path',
    join(payDir, 'Cargo.toml'),
    '--all-targets',
    '--',
    '-D',
    'warnings',
  ]);
  run('cargo', [
    'check',
    '--manifest-path',
    join(payDir, 'Cargo.toml'),
    '--target',
    'wasm32-unknown-unknown',
  ]);
  run('cargo', [
    'fmt',
    '--manifest-path',
    join(payDir, 'Cargo.toml'),
    '--',
    '--check',
  ]);
  run('rustfmt', ['--edition', '2024', '--check', paymentApi]);

  const sqlite = mkdtempSync(join(tmpdir(), 'fabushi-pay-'));
  const database = join(sqlite, 'schema.db');
  run('sqlite3', [database], {
    input: readFileSync(join(migrationsDir, '0001_platform.sql')),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  run('sqlite3', [database], {
    input: readFileSync(join(migrationsDir, '0007_fabushi_pay.sql')),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
});
