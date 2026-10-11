import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { AccountSyncStore } from '../src/account_sync_store.js';
import { browseExtensions, readExtension } from '../src/extension_registry.js';
import { ExtensionPublisherStore } from '../src/extension_publisher_store.js';
import {
  ExtensionReleaseStore,
  ExtensionReleaseStoreError,
} from '../src/extension_release_store.js';
import { createMiniAppMarketplaceRouter } from '../src/miniapp_marketplace_http.js';
import {
  verifyReleaseSignatureEnvelope,
  verifyTrustFeedEnvelope,
} from '../src/extension_signing_store.js';

function descriptor(version = '1.0.0') {
  return {
    identity: {
      namespace: 'acme-labs',
      name: 'offline-notes',
      kind: 'web-miniapp',
    },
    origin: 'team',
    trustDomain: 'team-authorized',
    displayName: 'Offline Notes',
    description: 'Offline private notes.',
    publisher: {
      id: 'someone-else',
      displayName: 'Acme Labs',
      verified: true,
      verificationEvidence: ['untrusted-client-claim'],
    },
    release: {
      version,
      channel: 'stable',
      platforms: ['desktop', 'ios', 'android'],
      requestedCapabilities: ['storage.local'],
      revoked: true,
    },
    categories: ['productivity'],
    tags: ['notes'],
    runtime: {
      owner: 'web-miniapp',
    },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-release-store-'));
  const accountStore = new AccountSyncStore({ dbPath: path.join(root, 'marketplace.sqlite') });
  const publisherStore = new ExtensionPublisherStore({ db: accountStore.db });
  const releaseStore = new ExtensionReleaseStore({
    db: accountStore.db,
    publisherStore,
  });
  publisherStore.create({
    namespace: 'acme-labs',
    displayName: 'Acme Labs',
    ownerAccountId: 'user:owner',
  });
  return {
    root,
    accountStore,
    publisherStore,
    releaseStore,
    close() {
      accountStore.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function emptyMarketplace() {
  return { list: () => [] };
}

test('release draft is immutable and server overwrites trust-sensitive publisher claims', () => {
  const scope = fixture();
  try {
    const created = scope.releaseStore.createDraft({
      actorAccountId: 'user:owner',
      descriptor: descriptor(),
    });
    assert.equal(created.state, 'draft');
    assert.equal(created.descriptor.origin, 'public');
    assert.equal(created.descriptor.trustDomain, 'catalog-authorized');
    assert.equal(created.descriptor.publisher.id, 'acme-labs');
    assert.equal(created.descriptor.publisher.verified, false);
    assert.deepEqual(created.descriptor.publisher.verificationEvidence, []);
    assert.equal(created.descriptor.release.revoked, false);
    assert.match(created.descriptorDigest, /^[0-9a-f]{64}$/);

    assert.throws(
      () => scope.releaseStore.createDraft({
        actorAccountId: 'user:owner',
        descriptor: { ...descriptor(), displayName: 'Replacement' },
      }),
      (error) => error instanceof ExtensionReleaseStoreError && error.code === 'RELEASE_CONFLICT',
    );
  } finally {
    scope.close();
  }
});

test('only namespace owner can create/submit and transfer gives current owner release control', () => {
  const scope = fixture();
  try {
    assert.throws(
      () => scope.releaseStore.createDraft({
        actorAccountId: 'user:attacker',
        descriptor: descriptor(),
      }),
      /owned by another account/,
    );

    scope.releaseStore.createDraft({
      actorAccountId: 'user:owner',
      descriptor: descriptor(),
    });
    const transfer = scope.publisherStore.proposeTransfer({
      namespace: 'acme-labs',
      actorAccountId: 'user:owner',
      targetAccountId: 'user:new-owner',
    });
    scope.publisherStore.acceptTransfer({
      namespace: 'acme-labs',
      actorAccountId: 'user:new-owner',
      transferId: transfer.transferId,
    });

    const submitted = scope.releaseStore.submit({
      actorAccountId: 'user:new-owner',
      kind: 'web-miniapp',
      namespace: 'acme-labs',
      name: 'offline-notes',
      version: '1.0.0',
    });
    assert.equal(submitted.state, 'pending_review');
    assert.deepEqual(scope.releaseStore.listPublisher('user:owner'), []);
    assert.equal(scope.releaseStore.listPublisher('user:new-owner')[0].state, 'pending_review');
  } finally {
    scope.close();
  }
});

test('public registry exposes only approved latest releases and removes revoked release immediately', () => {
  const scope = fixture();
  try {
    scope.releaseStore.createDraft({
      actorAccountId: 'user:owner',
      descriptor: descriptor('1.0.0'),
    });
    scope.releaseStore.submit({
      actorAccountId: 'user:owner',
      kind: 'web-miniapp',
      namespace: 'acme-labs',
      name: 'offline-notes',
      version: '1.0.0',
    });

    let page = browseExtensions(emptyMarketplace(), { query: 'offline notes' }, scope.releaseStore);
    assert.deepEqual(page.entries, []);

    const approved = scope.releaseStore.review({
      kind: 'web-miniapp',
      namespace: 'acme-labs',
      name: 'offline-notes',
      version: '1.0.0',
      approved: true,
      reviewer: 'security-reviewer',
      notes: 'approved after review',
    });
    assert.equal(approved.state, 'approved');

    page = browseExtensions(emptyMarketplace(), { query: 'offline notes' }, scope.releaseStore);
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].id, 'acme-labs/offline-notes:web-miniapp');
    assert.equal(page.entries[0].release.version, '1.0.0');
    assert.equal(page.entries[0].release.descriptorDigest, approved.descriptorDigest);

    scope.releaseStore.createDraft({
      actorAccountId: 'user:owner',
      descriptor: descriptor('1.1.0'),
    });
    scope.releaseStore.submit({
      actorAccountId: 'user:owner',
      kind: 'web-miniapp',
      namespace: 'acme-labs',
      name: 'offline-notes',
      version: '1.1.0',
    });
    scope.releaseStore.review({
      kind: 'web-miniapp',
      namespace: 'acme-labs',
      name: 'offline-notes',
      version: '1.1.0',
      approved: true,
      reviewer: 'security-reviewer',
    });
    assert.equal(
      readExtension(
        emptyMarketplace(),
        { kind: 'web-miniapp', namespace: 'acme-labs', name: 'offline-notes' },
        scope.releaseStore,
      ).release.version,
      '1.1.0',
    );

    scope.releaseStore.revoke({
      kind: 'web-miniapp',
      namespace: 'acme-labs',
      name: 'offline-notes',
      version: '1.1.0',
      reviewer: 'security-reviewer',
      notes: 'security incident',
    });
    assert.equal(
      readExtension(
        emptyMarketplace(),
        { kind: 'web-miniapp', namespace: 'acme-labs', name: 'offline-notes' },
        scope.releaseStore,
      ).release.version,
      '1.0.0',
      'revoking latest must fall back to the last still-approved version',
    );

    scope.releaseStore.yank({
      actorAccountId: 'user:owner',
      kind: 'web-miniapp',
      namespace: 'acme-labs',
      name: 'offline-notes',
      version: '1.0.0',
      notes: 'publisher withdrawal',
    });
    assert.throws(
      () => readExtension(
        emptyMarketplace(),
        { kind: 'web-miniapp', namespace: 'acme-labs', name: 'offline-notes' },
        scope.releaseStore,
      ),
      /was not found/,
    );
  } finally {
    scope.close();
  }
});

test('release audit records state transitions in order without reviewer credentials', () => {
  const scope = fixture();
  try {
    scope.releaseStore.createDraft({ actorAccountId: 'user:owner', descriptor: descriptor() });
    scope.releaseStore.submit({
      actorAccountId: 'user:owner',
      kind: 'web-miniapp',
      namespace: 'acme-labs',
      name: 'offline-notes',
      version: '1.0.0',
    });
    scope.releaseStore.review({
      kind: 'web-miniapp',
      namespace: 'acme-labs',
      name: 'offline-notes',
      version: '1.0.0',
      approved: false,
      reviewer: 'reviewer-1',
      notes: 'needs changes',
    });
    const audit = scope.releaseStore.audit({
      kind: 'web-miniapp',
      namespace: 'acme-labs',
      name: 'offline-notes',
      version: '1.0.0',
    });
    assert.deepEqual(audit.map((item) => item.action), [
      'release.created',
      'release.submitted',
      'release.rejected',
    ]);
    assert.doesNotMatch(JSON.stringify(audit), /review-token|authorization|secret/i);
  } finally {
    scope.close();
  }
});

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-release-http-'));
  const previousReviewToken = process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN;
  const previousSigningKey = process.env.FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY;
  const previousSigningKeyId = process.env.FABUSHI_MARKETPLACE_SIGNING_KEY_ID;
  const previousTrustEpoch = process.env.FABUSHI_MARKETPLACE_TRUST_EPOCH;
  process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN = 'r'.repeat(48);
  const testSigningKey = crypto.generateKeyPairSync('ed25519').privateKey
    .export({ type: 'pkcs8', format: 'pem' });
  process.env.FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY = testSigningKey;
  process.env.FABUSHI_MARKETPLACE_SIGNING_KEY_ID = 'test-marketplace-key';
  process.env.FABUSHI_MARKETPLACE_TRUST_EPOCH = '1';
  const users = new Map([
    ['owner-token', { userId: 'user:owner', username: 'owner', isAuthenticated: true }],
    ['attacker-token', { userId: 'user:attacker', username: 'attacker', isAuthenticated: true }],
  ]);
  const resolveUser = async (req) => {
    const token = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const user = users.get(token);
    if (!user) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    return user;
  };
  const { default: express } = await import('express');
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
    if (previousReviewToken === undefined) delete process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN;
    else process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN = previousReviewToken;
    if (previousSigningKey === undefined) delete process.env.FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY;
    else process.env.FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY = previousSigningKey;
    if (previousSigningKeyId === undefined) delete process.env.FABUSHI_MARKETPLACE_SIGNING_KEY_ID;
    else process.env.FABUSHI_MARKETPLACE_SIGNING_KEY_ID = previousSigningKeyId;
    if (previousTrustEpoch === undefined) delete process.env.FABUSHI_MARKETPLACE_TRUST_EPOCH;
    else process.env.FABUSHI_MARKETPLACE_TRUST_EPOCH = previousTrustEpoch;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('HTTP workflow gates public discovery on authenticated publisher and reviewer approval', async () => {
  await withServer(async (baseUrl) => {
    const ownerHeaders = {
      authorization: 'Bearer owner-token',
      'content-type': 'application/json',
    };
    const namespace = await fetch(`${baseUrl}/v1/extensions/publisher/namespaces`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ namespace: 'acme-labs', displayName: 'Acme Labs' }),
    });
    assert.equal(namespace.status, 201);

    const draft = await fetch(`${baseUrl}/v1/extensions/publisher/releases`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ descriptor: descriptor() }),
    });
    assert.equal(draft.status, 201);
    const draftPayload = await draft.json();
    assert.equal(draftPayload.release.state, 'draft');

    const upload = await fetch(`${baseUrl}/v1/extensions/publisher/artifacts`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer owner-token',
        'content-type': 'application/octet-stream',
        'x-fabushi-extension-kind': 'web-miniapp',
        'x-fabushi-extension-namespace': 'acme-labs',
        'x-fabushi-extension-name': 'offline-notes',
        'x-fabushi-extension-version': '1.0.0',
        'x-fabushi-artifact-id': 'universal-ui',
        'x-fabushi-artifact-platform': 'all',
        'x-fabushi-artifact-format': 'fabapp',
      },
      body: Buffer.from('release workflow package'),
    });
    assert.equal(upload.status, 201);

    const submit = await fetch(
      `${baseUrl}/v1/extensions/publisher/releases/web-miniapp/acme-labs/offline-notes/1.0.0/submit`,
      { method: 'POST', headers: ownerHeaders },
    );
    assert.equal(submit.status, 200);

    const beforeApproval = await fetch(`${baseUrl}/v1/extensions?q=offline%20notes`);
    assert.equal(beforeApproval.status, 200);
    assert.deepEqual((await beforeApproval.json()).entries.filter((item) => item.id.startsWith('acme-labs/')), []);

    const unauthorizedReview = await fetch(
      `${baseUrl}/v1/extensions/review/releases/web-miniapp/acme-labs/offline-notes/1.0.0`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      },
    );
    assert.equal(unauthorizedReview.status, 403);

    const scan = await fetch(
      `${baseUrl}/v1/extensions/review/artifacts/web-miniapp/acme-labs/offline-notes/1.0.0/universal-ui/scan`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fabushi-marketplace-review-token': 'r'.repeat(48),
        },
        body: JSON.stringify({
          state: 'passed',
          scanner: 'fabushi-static-scan',
          scannerVersion: '1.0.0',
          reviewer: 'security-reviewer',
        }),
      },
    );
    assert.equal(scan.status, 200);

    const approved = await fetch(
      `${baseUrl}/v1/extensions/review/releases/web-miniapp/acme-labs/offline-notes/1.0.0`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fabushi-marketplace-review-token': 'r'.repeat(48),
        },
        body: JSON.stringify({ approved: true, reviewer: 'security-reviewer' }),
      },
    );
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).release.state, 'approved');

    const afterApproval = await fetch(`${baseUrl}/v1/extensions?q=offline%20notes`);
    const afterPayload = await afterApproval.json();
    const approvedEntry = afterPayload.entries.find(
      (item) => item.id === 'acme-labs/offline-notes:web-miniapp',
    );
    assert.ok(approvedEntry);
    assert.equal(verifyReleaseSignatureEnvelope(approvedEntry.release.signature), true);
    const signedPayload = JSON.parse(approvedEntry.release.signature.payload);
    assert.equal(signedPayload.descriptorDigest, approvedEntry.release.descriptorDigest);
    assert.deepEqual(
      signedPayload.artifacts.map((artifact) => artifact.digest),
      approvedEntry.release.artifacts.map((artifact) => artifact.digest),
    );

    const yanked = await fetch(
      `${baseUrl}/v1/extensions/publisher/releases/web-miniapp/acme-labs/offline-notes/1.0.0/yank`,
      {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ notes: 'withdrawn' }),
      },
    );
    assert.equal(yanked.status, 200);

    const afterYank = await fetch(`${baseUrl}/v1/extensions?q=offline%20notes`);
    assert.deepEqual((await afterYank.json()).entries.filter((item) => item.id.startsWith('acme-labs/')), []);
  });
});


test('HTTP trust feed is signed and current signer revocation requires rotation', async () => {
  await withServer(async (baseUrl) => {
    const feedResponse = await fetch(`${baseUrl}/v1/extensions/trust`);
    assert.equal(feedResponse.status, 200);
    const feed = (await feedResponse.json()).trust;
    assert.equal(feed.protocol, 'fabushi.extension-trust-feed.v1');
    assert.equal(verifyTrustFeedEnvelope(feed, { nowMs: Date.now() }), true);

    const unauthorized = await fetch(
      `${baseUrl}/v1/extensions/review/trust/${encodeURIComponent(feed.keyId)}/${feed.trustEpoch}/revoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'attempt without review authority' }),
      },
    );
    assert.equal(unauthorized.status, 403);

    const selfRevoke = await fetch(
      `${baseUrl}/v1/extensions/review/trust/${encodeURIComponent(feed.keyId)}/${feed.trustEpoch}/revoke`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fabushi-marketplace-review-token': 'r'.repeat(48),
        },
        body: JSON.stringify({ reason: 'compromise' }),
      },
    );
    assert.equal(selfRevoke.status, 409);
    assert.equal((await selfRevoke.json()).error.code, 'ACTIVE_SIGNER_REVOCATION_REQUIRES_ROTATION');

    const stillValid = (await (await fetch(`${baseUrl}/v1/extensions/trust`)).json()).trust;
    assert.equal(verifyTrustFeedEnvelope(stillValid, { nowMs: Date.now() }), true);
  });
});
