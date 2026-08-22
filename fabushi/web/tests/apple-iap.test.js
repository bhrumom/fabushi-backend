import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { generateToken } from '../auth-utils.js';
import { deterministicAppAccountToken, handleVerifyAppleReceipt } from '../src/handlers/apple-iap.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

async function privateKeyPem() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const body = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

async function env() {
  return {
    JWT_SECRET: 'apple-iap-test-secret-that-is-at-least-32-bytes-long',
    APPLE_ISSUER_ID: 'issuer-id',
    APPLE_KEY_ID: 'key-id',
    APPLE_PRIVATE_KEY: (await privateKeyPem()).replace(/\n/g, '\\n'),
    APPLE_BUNDLE_ID: 'com.ombhrum.fabushi',
  };
}

function appleOptions(payload) {
  return {
    fetchImpl: async () => new Response(JSON.stringify({ signedTransactionInfo: 'server-fetched-fixture' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    verifyJws: async (value) => {
      assert.equal(value, 'server-fetched-fixture');
      return { environment: 'Production', ...payload };
    },
  };
}

function request(token, transactionId, productId) {
  return new Request('https://example.com/api/apple-iap/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionId, productId }),
  });
}

function fakeDb(user, existingPurchase = null) {
  const state = { updates: [], batches: [], userIdLookups: [], ledger: null };
  const raw = {
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) { this.params = params; return this; },
        async run() { return { meta: { changes: 0 } }; },
        async first() {
          if (sql.includes('apple_iap_receipts') && sql.includes('SELECT')) return state.ledger;
          return null;
        },
      };
      return statement;
    },
    async batch(statements) {
      state.batches.push(statements);
      const receipt = statements.find((item) => item.sql.includes('INSERT INTO apple_iap_receipts'));
      if (receipt) state.ledger = { user_id: receipt.params[2], username: receipt.params[3] };
      return statements.map(() => ({ success: true }));
    },
  };
  return {
    db: raw,
    state,
    async getUserById(id) { state.userIdLookups.push(id); return String(id) === String(user.id) ? { ...user } : null; },
    async getUser(username) { return username === user.username ? { ...user } : null; },
    async updateUser(username, updates) { state.updates.push({ username, updates }); Object.assign(user, updates); },
    prepare(sql) {
      return {
        bind() { return this; },
        async first() { return sql.includes('purchase_history') ? existingPurchase : null; },
      };
    },
  };
}

test('Apple IAP rejects a transaction bound to another Fabushi account', async () => {
  const e = await env();
  const user = { id: 42, username: 'apple_user', membership_type: 'expired', membership_expires_at: null };
  const token = await generateToken({ id: 42, username: user.username }, e);
  const transactionId = '2000000000001001';
  const options = appleOptions({
    transactionId,
    productId: 'monthly',
    bundleId: e.APPLE_BUNDLE_ID,
    appAccountToken: '00000000-0000-5000-8000-000000000000',
    purchaseDate: Date.UTC(2026, 6, 1),
    expiresDate: Date.UTC(2026, 7, 1),
  });
  const response = await handleVerifyAppleReceipt(request(token, transactionId, 'monthly'), e, fakeDb(user), options);
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, 'APP_ACCOUNT_TOKEN_MISMATCH');
  assert.equal(body.appAccountToken, await deterministicAppAccountToken(user));
});

test('Apple IAP fulfills an account-bound subscription atomically using Apple expiry', async () => {
  const e = await env();
  const user = { id: 42, username: 'apple_user', membership_type: 'expired', membership_expires_at: null };
  const token = await generateToken({ id: 42, username: user.username }, e);
  const transactionId = '2000000000001002';
  const accountToken = await deterministicAppAccountToken(user);
  const expiresDate = Date.UTC(2026, 7, 17, 12, 0, 0);
  const options = appleOptions({
    transactionId,
    originalTransactionId: '2000000000000001',
    productId: 'monthly',
    bundleId: e.APPLE_BUNDLE_ID,
    appAccountToken: accountToken,
    purchaseDate: Date.UTC(2026, 6, 17, 12, 0, 0),
    expiresDate,
  });
  const db = fakeDb(user);
  const response = await handleVerifyAppleReceipt(request(token, transactionId, 'monthly'), e, db, options);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.membershipType, 'paid');
  assert.equal(body.expiresAt, new Date(expiresDate).toISOString());
  assert.equal(db.state.batches.length, 1);
  assert.equal(db.state.batches[0].some((item) => item.sql.includes('INSERT INTO apple_iap_receipts')), true);
  assert.equal(db.state.batches[0].some((item) => item.sql.includes('INSERT INTO purchase_history')), true);
  assert.equal(db.state.batches[0].some((item) => item.sql.includes('UPDATE users')), true);
});

test('Apple IAP rejects a JWS environment that does not match the server endpoint', async () => {
  const e = await env();
  const user = { id: 42, username: 'apple_user', membership_type: 'expired', membership_expires_at: null };
  const token = await generateToken({ id: 42, username: user.username }, e);
  const transactionId = '2000000000001004';
  const options = {
    ...appleOptions({ transactionId, productId: 'monthly', bundleId: e.APPLE_BUNDLE_ID }),
    verifyJws: async () => ({
      environment: 'Sandbox',
      transactionId,
      productId: 'monthly',
      bundleId: e.APPLE_BUNDLE_ID,
    }),
  };
  const response = await handleVerifyAppleReceipt(request(token, transactionId, 'monthly'), e, fakeDb(user), options);
  assert.equal(response.status, 502);
});

test('historical Apple purchase can only restore the original account', async () => {
  const e = await env();
  const user = { id: 42, username: 'apple_user', membership_type: 'expired', membership_expires_at: '2026-05-01T00:00:00.000Z' };
  const token = await generateToken({ id: 42, username: user.username }, e);
  const transactionId = '2000000000001003';
  const restoredExpiry = '2026-08-01T00:00:00.000Z';
  const existing = { user_id: 42, username: user.username, order_id: transactionId, valid_to: restoredExpiry };
  const response = await handleVerifyAppleReceipt(request(token, transactionId, 'monthly'), e, fakeDb(user, existing));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.alreadyProcessed, true);
  assert.equal(body.expiresAt, restoredExpiry);
});
