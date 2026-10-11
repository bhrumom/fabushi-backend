import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { AccountSyncStore } from '../src/account_sync_store.js';
import {
  ExtensionPublisherStore,
  ExtensionPublisherStoreError,
} from '../src/extension_publisher_store.js';
import { createMiniAppMarketplaceRouter } from '../src/miniapp_marketplace_http.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-publisher-namespace-'));
  const dbPath = path.join(root, 'marketplace.sqlite');
  let now = 1_900_000_000_000;
  const accountStore = new AccountSyncStore({ dbPath, now: () => ++now });
  const store = new ExtensionPublisherStore({ db: accountStore.db, now: () => ++now });
  return {
    root,
    dbPath,
    accountStore,
    store,
    close() {
      accountStore.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('namespace claim is durable, private ownership is not exposed publicly, and duplicates fail closed', () => {
  const scope = fixture();
  try {
    const created = scope.store.create({
      namespace: 'acme-labs',
      displayName: 'Acme Labs',
      ownerAccountId: 'user:owner',
    });
    assert.deepEqual(Object.keys(created).sort(), [
      'createdAtMs',
      'displayName',
      'namespace',
      'status',
      'transferPending',
      'updatedAtMs',
    ].sort());
    assert.equal(created.namespace, 'acme-labs');
    assert.equal(JSON.stringify(created).includes('user:owner'), false);

    assert.throws(
      () => scope.store.create({
        namespace: 'acme-labs',
        displayName: 'Other',
        ownerAccountId: 'user:attacker',
      }),
      (error) => error instanceof ExtensionPublisherStoreError && error.code === 'NAMESPACE_CONFLICT',
    );

    const firstAudit = scope.store.audit('acme-labs');
    assert.deepEqual(firstAudit.map((event) => event.action), ['namespace.created']);
    assert.equal(firstAudit[0].actorAccountId, 'user:owner');

    scope.accountStore.close();
    const reopenedAccountStore = new AccountSyncStore({ dbPath: scope.dbPath });
    try {
      const reopened = new ExtensionPublisherStore({ db: reopenedAccountStore.db });
      assert.equal(reopened.getPublic('acme-labs').displayName, 'Acme Labs');
      assert.deepEqual(reopened.listOwned('user:owner').map((item) => item.namespace), ['acme-labs']);
    } finally {
      reopenedAccountStore.close();
    }
    // close() below would close the already closed first store, so just remove.
    fs.rmSync(scope.root, { recursive: true, force: true });
  } finally {
    // The first AccountSyncStore may already be closed by the durability check.
  }
});

test('reserved system namespace cannot be claimed while syntax remains readable', () => {
  const scope = fixture();
  try {
    assert.throws(
      () => scope.store.create({
        namespace: 'fabushi',
        displayName: 'Imposter',
        ownerAccountId: 'user:attacker',
      }),
      (error) => error instanceof ExtensionPublisherStoreError && error.code === 'RESERVED_NAMESPACE',
    );
    assert.equal(scope.store.getPublic('fabushi'), null);
  } finally {
    scope.close();
  }
});

test('only owner can mutate and namespace transfer requires exact target acceptance', () => {
  const scope = fixture();
  try {
    scope.store.create({
      namespace: 'acme-labs',
      displayName: 'Acme Labs',
      ownerAccountId: 'user:owner',
    });

    assert.throws(
      () => scope.store.update({
        namespace: 'acme-labs',
        actorAccountId: 'user:attacker',
        displayName: 'Stolen',
      }),
      (error) => error instanceof ExtensionPublisherStoreError && error.code === 'NAMESPACE_FORBIDDEN',
    );

    const transfer = scope.store.proposeTransfer({
      namespace: 'acme-labs',
      actorAccountId: 'user:owner',
      targetAccountId: 'user:target',
    });
    assert.equal(scope.store.getPublic('acme-labs').transferPending, true);

    assert.throws(
      () => scope.store.acceptTransfer({
        namespace: 'acme-labs',
        actorAccountId: 'user:attacker',
        transferId: transfer.transferId,
      }),
      (error) => error instanceof ExtensionPublisherStoreError && error.code === 'TRANSFER_FORBIDDEN',
    );

    assert.throws(
      () => scope.store.acceptTransfer({
        namespace: 'acme-labs',
        actorAccountId: 'user:target',
        transferId: 'wrong-transfer-id',
      }),
      (error) => error instanceof ExtensionPublisherStoreError && error.code === 'TRANSFER_MISMATCH',
    );

    const accepted = scope.store.acceptTransfer({
      namespace: 'acme-labs',
      actorAccountId: 'user:target',
      transferId: transfer.transferId,
    });
    assert.equal(accepted.transferPending, false);
    assert.deepEqual(scope.store.listOwned('user:owner'), []);
    assert.deepEqual(scope.store.listOwned('user:target').map((item) => item.namespace), ['acme-labs']);

    const audit = scope.store.audit('acme-labs');
    assert.deepEqual(audit.map((event) => event.action), [
      'namespace.created',
      'namespace.transfer.proposed',
      'namespace.transfer.accepted',
    ]);
    assert.ok(audit[0].sequence < audit[1].sequence && audit[1].sequence < audit[2].sequence);
  } finally {
    scope.close();
  }
});

test('owner can cancel a pending transfer without changing ownership', () => {
  const scope = fixture();
  try {
    scope.store.create({
      namespace: 'acme-labs',
      displayName: 'Acme Labs',
      ownerAccountId: 'user:owner',
    });
    scope.store.proposeTransfer({
      namespace: 'acme-labs',
      actorAccountId: 'user:owner',
      targetAccountId: 'user:target',
    });
    const cancelled = scope.store.cancelTransfer({
      namespace: 'acme-labs',
      actorAccountId: 'user:owner',
    });
    assert.equal(cancelled.transferPending, false);
    assert.deepEqual(scope.store.listOwned('user:owner').map((item) => item.namespace), ['acme-labs']);
    assert.deepEqual(scope.store.audit('acme-labs').map((event) => event.action), [
      'namespace.created',
      'namespace.transfer.proposed',
      'namespace.transfer.cancelled',
    ]);
  } finally {
    scope.close();
  }
});

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-publisher-http-'));
  const accounts = new Map([
    ['owner-token', { userId: 'user:owner', username: 'owner', isAuthenticated: true }],
    ['target-token', { userId: 'user:target', username: 'target', isAuthenticated: true }],
    ['attacker-token', { userId: 'user:attacker', username: 'attacker', isAuthenticated: true }],
  ]);
  const resolveUser = async (req) => {
    const token = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const user = accounts.get(token);
    if (!user) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    return user;
  };
  const app = express();
  const { router } = createMiniAppMarketplaceRouter({
    dataDir: root,
    storagePath: path.join(root, 'marketplace.json'),
    resolveUser,
  });
  app.use(router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function json(response) {
  const payload = await response.json();
  return { response, payload };
}

test('HTTP namespace API reuses authenticated account identity and never exposes owner account publicly', async () => {
  await withServer(async (baseUrl) => {
    const ownerHeaders = {
      authorization: 'Bearer owner-token',
      'content-type': 'application/json',
    };
    const targetHeaders = {
      authorization: 'Bearer target-token',
      'content-type': 'application/json',
    };
    const attackerHeaders = {
      authorization: 'Bearer attacker-token',
      'content-type': 'application/json',
    };

    const created = await json(await fetch(`${baseUrl}/v1/extensions/publisher/namespaces`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ namespace: 'acme-labs', displayName: 'Acme Labs' }),
    }));
    assert.equal(created.response.status, 201);

    const publicRead = await json(await fetch(`${baseUrl}/v1/extensions/namespaces/acme-labs`));
    assert.equal(publicRead.response.status, 200);
    assert.equal(publicRead.payload.namespace.namespace, 'acme-labs');
    assert.doesNotMatch(JSON.stringify(publicRead.payload), /user:owner|ownerAccountId/i);

    const forbidden = await json(await fetch(`${baseUrl}/v1/extensions/publisher/namespaces/acme-labs`, {
      method: 'PATCH',
      headers: attackerHeaders,
      body: JSON.stringify({ displayName: 'Stolen' }),
    }));
    assert.equal(forbidden.response.status, 403);
    assert.equal(forbidden.payload.error.code, 'NAMESPACE_FORBIDDEN');

    const proposed = await json(await fetch(`${baseUrl}/v1/extensions/publisher/namespaces/acme-labs/transfer`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ targetAccountId: 'user:target' }),
    }));
    assert.equal(proposed.response.status, 201);
    assert.ok(proposed.payload.transfer.transferId);

    const accepted = await json(await fetch(`${baseUrl}/v1/extensions/publisher/namespaces/acme-labs/transfer/accept`, {
      method: 'POST',
      headers: targetHeaders,
      body: JSON.stringify({ transferId: proposed.payload.transfer.transferId }),
    }));
    assert.equal(accepted.response.status, 200);

    const targetList = await json(await fetch(`${baseUrl}/v1/extensions/publisher/namespaces`, {
      headers: targetHeaders,
    }));
    assert.equal(targetList.response.status, 200);
    assert.deepEqual(targetList.payload.namespaces.map((item) => item.namespace), ['acme-labs']);
  });
});
