import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { generateToken } from '../auth-utils.js';
import { handleVerifyAppleReceipt } from '../src/handlers/apple-iap.js';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

function encodeJwsPayload(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `e30.${encodedPayload}.sig`;
}

async function createPrivateKeyPem() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const body = Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

async function createAppleEnv() {
  return {
    JWT_SECRET: 'apple-iap-test-secret',
    APPLE_ISSUER_ID: ' issuer-id ',
    APPLE_KEY_ID: ' key-id ',
    APPLE_PRIVATE_KEY: (await createPrivateKeyPem()).replace(/\n/g, '\\n'),
    APPLE_BUNDLE_ID: ' com.ombhrum.fabushi ',
  };
}

function installAppleFetch(transactionPayload) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ signedTransactionInfo: encodeJwsPayload(transactionPayload) }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  return () => {
    globalThis.fetch = originalFetch;
    return calls;
  };
}

function createRequest({ token, transactionId, productId }) {
  return new Request('https://example.com/api/apple-iap/verify', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ transactionId, productId }),
  });
}

function createDb({ user, existingPurchase = null } = {}) {
  const state = {
    user: { ...user },
    updates: [],
    purchases: [],
    userIdLookups: [],
    usernameLookups: [],
    selectParams: [],
  };

  return {
    state,
    async getUserById(id) {
      state.userIdLookups.push(id);
      return String(id) === String(state.user.id) ? { ...state.user } : null;
    },
    async getUser(username) {
      state.usernameLookups.push(username);
      return username === state.user.username ? { ...state.user } : null;
    },
    async updateUser(username, updates) {
      state.updates.push({ username, updates });
      Object.assign(state.user, updates);
    },
    async addPurchaseHistory(data) {
      state.purchases.push(data);
    },
    prepare() {
      return {
        bind(...params) {
          state.selectParams.push(params);
          return this;
        },
        async first() {
          return existingPurchase;
        },
      };
    },
  };
}

test('apple membership verification resolves user by token userId before username', async () => {
  const env = await createAppleEnv();
  const token = await generateToken({ id: 42, username: 'stale_username' }, env);
  const transactionId = '2000000000001001';
  const restoreFetch = installAppleFetch({
    productId: 'monthly',
    bundleId: 'com.ombhrum.fabushi',
    purchaseDate: Date.UTC(2026, 4, 31),
    environment: 'Sandbox',
  });
  const db = createDb({
    user: {
      id: 42,
      username: 'apple_user',
      membership_type: 'expired',
      membership_expires_at: null,
    },
  });

  try {
    const response = await handleVerifyAppleReceipt(
      createRequest({ token, transactionId, productId: 'monthly' }),
      env,
      db,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.membershipType, 'paid');
    assert.equal(db.state.userIdLookups[0], 42);
    assert.deepEqual(db.state.usernameLookups, []);
    assert.equal(db.state.updates[0].username, 'apple_user');
    assert.equal(db.state.purchases[0].username, 'apple_user');
    assert.equal(db.state.purchases[0].userId, 42);
    assert.match(body.expiresAt, /^2026-/);
  } finally {
    restoreFetch();
  }
});

test('already processed apple membership transaction restores stale membership expiry', async () => {
  const env = await createAppleEnv();
  const token = await generateToken({ id: 42, username: 'stale_username' }, env);
  const transactionId = '2000000000001002';
  const restoredExpiry = '2026-08-01T00:00:00.000Z';
  const restoreFetch = installAppleFetch({
    productId: 'monthly',
    bundleId: 'com.ombhrum.fabushi',
    purchaseDate: Date.UTC(2026, 4, 31),
    environment: 'Sandbox',
  });
  const db = createDb({
    user: {
      id: 42,
      username: 'apple_user',
      membership_type: 'expired',
      membership_expires_at: '2026-05-01T00:00:00.000Z',
    },
    existingPurchase: {
      user_id: 42,
      username: 'apple_user',
      order_id: transactionId,
      plan: 'monthly',
      status: 'completed',
      valid_to: restoredExpiry,
    },
  });

  try {
    const response = await handleVerifyAppleReceipt(
      createRequest({ token, transactionId, productId: 'monthly' }),
      env,
      db,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.alreadyProcessed, true);
    assert.equal(body.membershipType, 'paid');
    assert.equal(body.expiresAt, restoredExpiry);
    assert.deepEqual(db.state.updates, [
      {
        username: 'apple_user',
        updates: {
          membership_type: 'paid',
          membership_expires_at: restoredExpiry,
        },
      },
    ]);
    assert.deepEqual(db.state.purchases, []);
  } finally {
    restoreFetch();
  }
});

test('apple buddha asset product records a permanent unlock purchase', async () => {
  const env = await createAppleEnv();
  const token = await generateToken({ id: 88, username: 'asset_user' }, env);
  const transactionId = '2000000000001003';
  const restoreFetch = installAppleFetch({
    productId: 'zen_buddha_asset',
    bundleId: 'com.ombhrum.fabushi',
    purchaseDate: Date.UTC(2026, 4, 31),
    environment: 'Sandbox',
  });
  const db = createDb({
    user: {
      id: 88,
      username: 'asset_user',
      membership_type: 'expired',
      membership_expires_at: null,
    },
  });

  try {
    const response = await handleVerifyAppleReceipt(
      createRequest({ token, transactionId, productId: 'zen_buddha_asset' }),
      env,
      db,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.productType, 'asset_unlock');
    assert.equal(body.unlocked, true);
    assert.deepEqual(db.state.updates, []);
    assert.equal(db.state.purchases[0].plan, 'zen_buddha_asset');
    assert.equal(db.state.purchases[0].userId, 88);
    assert.equal(db.state.purchases[0].validTo, '9999-12-31T23:59:59.999Z');
  } finally {
    restoreFetch();
  }
});
