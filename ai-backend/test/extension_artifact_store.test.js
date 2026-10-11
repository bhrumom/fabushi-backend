import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import express from 'express';

import { AccountSyncStore } from '../src/account_sync_store.js';
import { ExtensionArtifactStore, ExtensionArtifactStoreError } from '../src/extension_artifact_store.js';
import { ExtensionPublisherStore } from '../src/extension_publisher_store.js';
import { ExtensionReleaseStore, ExtensionReleaseStoreError } from '../src/extension_release_store.js';
import { ExtensionSigningStore } from '../src/extension_signing_store.js';
import { createMiniAppMarketplaceRouter } from '../src/miniapp_marketplace_http.js';

function descriptor(version = '1.0.0') {
  return {
    identity: { namespace: 'acme-labs', name: 'offline-notes', kind: 'web-miniapp' },
    origin: 'public',
    trustDomain: 'catalog-authorized',
    displayName: 'Offline Notes',
    description: 'Offline private notes.',
    publisher: { id: 'acme-labs', displayName: 'Acme Labs' },
    release: {
      version,
      channel: 'stable',
      platforms: ['desktop', 'ios', 'android'],
      requestedCapabilities: ['storage.local'],
    },
    runtime: { owner: 'web-miniapp' },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-artifact-cas-'));
  const accountStore = new AccountSyncStore({ dbPath: path.join(root, 'marketplace.sqlite') });
  const publisherStore = new ExtensionPublisherStore({ db: accountStore.db });
  const releaseStore = new ExtensionReleaseStore({ db: accountStore.db, publisherStore });
  const artifactStore = new ExtensionArtifactStore({
    db: accountStore.db,
    dataDir: root,
    publisherStore,
    releaseStore,
  });
  releaseStore.setArtifactStore(artifactStore);
  publisherStore.create({
    namespace: 'acme-labs',
    displayName: 'Acme Labs',
    ownerAccountId: 'user:owner',
  });
  releaseStore.createDraft({ actorAccountId: 'user:owner', descriptor: descriptor() });
  return {
    root,
    accountStore,
    publisherStore,
    releaseStore,
    artifactStore,
    close() {
      accountStore.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function key() {
  return {
    kind: 'web-miniapp',
    namespace: 'acme-labs',
    name: 'offline-notes',
    version: '1.0.0',
  };
}

function signer(keyId, trustEpoch) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    publicKeyObject: publicKey,
    publicKey: publicDer.toString('base64'),
    publicKeyFingerprint: crypto.createHash('sha256').update(publicDer).digest('hex'),
    keyId,
    trustEpoch,
  };
}

test('artifact upload computes digest, stores by digest only, deduplicates same bytes, and freezes artifact id', () => {
  const scope = fixture();
  try {
    const bytes = Buffer.from('hello immutable artifact');
    const expected = crypto.createHash('sha256').update(bytes).digest('hex');
    const first = scope.artifactStore.upload({
      actorAccountId: 'user:owner',
      ...key(),
      artifactId: 'universal-ui',
      platform: 'all',
      format: 'fabapp',
      bytes,
    });
    assert.equal(first.digest, expected);
    assert.equal(first.sizeBytes, bytes.length);
    assert.equal(first.scan.state, 'pending');

    const expectedPath = path.join(
      scope.root,
      'extensions',
      'artifacts',
      'sha256',
      expected.slice(0, 2),
      expected,
    );
    assert.deepEqual(fs.readFileSync(expectedPath), bytes);
    assert.equal(expectedPath.includes('acme-labs'), false);
    assert.equal(expectedPath.includes('offline-notes'), false);

    const repeated = scope.artifactStore.upload({
      actorAccountId: 'user:owner',
      ...key(),
      artifactId: 'universal-ui',
      platform: 'all',
      format: 'fabapp',
      bytes,
    });
    assert.equal(repeated.digest, expected);

    assert.throws(
      () => scope.artifactStore.upload({
        actorAccountId: 'user:owner',
        ...key(),
        artifactId: 'universal-ui',
        platform: 'all',
        format: 'fabapp',
        bytes: Buffer.from('different bytes'),
      }),
      (error) => error instanceof ExtensionArtifactStoreError
        && error.code === 'ARTIFACT_BINDING_CONFLICT',
    );
  } finally {
    scope.close();
  }
});

test('artifact upload requires namespace ownership and an existing mutable release', () => {
  const scope = fixture();
  try {
    assert.throws(
      () => scope.artifactStore.upload({
        actorAccountId: 'user:attacker',
        ...key(),
        artifactId: 'package',
        platform: 'desktop',
        format: 'zip',
        bytes: Buffer.from('bytes'),
      }),
      /owned by another account/,
    );

    assert.throws(
      () => scope.artifactStore.upload({
        actorAccountId: 'user:owner',
        ...key(),
        version: '9.9.9',
        artifactId: 'package',
        platform: 'desktop',
        format: 'zip',
        bytes: Buffer.from('bytes'),
      }),
      (error) => error instanceof ExtensionArtifactStoreError
        && error.code === 'RELEASE_NOT_FOUND',
    );
  } finally {
    scope.close();
  }
});

test('release approval is blocked until every bound artifact passes immutable scan verdict', () => {
  const scope = fixture();
  try {
    scope.releaseStore.submit({ actorAccountId: 'user:owner', ...key() });
    assert.throws(
      () => scope.releaseStore.review({
        ...key(),
        approved: true,
        reviewer: 'security-reviewer',
      }),
      (error) => error instanceof ExtensionArtifactStoreError && error.code === 'ARTIFACT_REQUIRED',
    );

    scope.artifactStore.upload({
      actorAccountId: 'user:owner',
      ...key(),
      artifactId: 'package',
      platform: 'all',
      format: 'fabapp',
      bytes: Buffer.from('scanned bytes'),
    });
    assert.throws(
      () => scope.releaseStore.review({
        ...key(),
        approved: true,
        reviewer: 'security-reviewer',
      }),
      (error) => error instanceof ExtensionArtifactStoreError
        && error.code === 'ARTIFACT_SCAN_REQUIRED',
    );

    const passed = scope.artifactStore.recordScan({
      reviewer: 'security-reviewer',
      ...key(),
      artifactId: 'package',
      state: 'passed',
      scanner: 'fabushi-static-scan',
      scannerVersion: '1.0.0',
    });
    assert.equal(passed.scan.state, 'passed');
    assert.throws(
      () => scope.artifactStore.recordScan({
        reviewer: 'security-reviewer',
        ...key(),
        artifactId: 'package',
        state: 'rejected',
        scanner: 'other',
        scannerVersion: '1.0.0',
      }),
      (error) => error instanceof ExtensionArtifactStoreError
        && error.code === 'SCAN_ALREADY_FINAL',
    );

    const approved = scope.releaseStore.review({
      ...key(),
      approved: true,
      reviewer: 'security-reviewer',
    });
    assert.equal(approved.state, 'approved');

    const publicArtifacts = scope.releaseStore.listApprovedLatest()[0].release.artifacts;
    assert.equal(publicArtifacts.length, 1);
    assert.equal(publicArtifacts[0].scan.state, 'passed');
  } finally {
    scope.close();
  }
});

test('rejected scan permanently blocks approval for that immutable artifact binding', () => {
  const scope = fixture();
  try {
    scope.artifactStore.upload({
      actorAccountId: 'user:owner',
      ...key(),
      artifactId: 'package',
      platform: 'all',
      format: 'fabapp',
      bytes: Buffer.from('malicious bytes'),
    });
    scope.artifactStore.recordScan({
      reviewer: 'security-reviewer',
      ...key(),
      artifactId: 'package',
      state: 'rejected',
      scanner: 'fabushi-static-scan',
      scannerVersion: '1.0.0',
      notes: 'malicious payload',
    });
    scope.releaseStore.submit({ actorAccountId: 'user:owner', ...key() });
    assert.throws(
      () => scope.releaseStore.review({
        ...key(),
        approved: true,
        reviewer: 'security-reviewer',
      }),
      /has not passed security scan/,
    );
  } finally {
    scope.close();
  }
});

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-artifact-http-'));
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
  ]);
  const resolveUser = async (req) => {
    const token = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const user = users.get(token);
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

test('HTTP raw upload -> scan -> approve -> byte-for-byte immutable download works', async () => {
  await withServer(async (baseUrl) => {
    const ownerJson = {
      authorization: 'Bearer owner-token',
      'content-type': 'application/json',
    };
    assert.equal((await fetch(`${baseUrl}/v1/extensions/publisher/namespaces`, {
      method: 'POST',
      headers: ownerJson,
      body: JSON.stringify({ namespace: 'acme-labs', displayName: 'Acme Labs' }),
    })).status, 201);

    assert.equal((await fetch(`${baseUrl}/v1/extensions/publisher/releases`, {
      method: 'POST',
      headers: ownerJson,
      body: JSON.stringify({ descriptor: descriptor() }),
    })).status, 201);

    const bytes = Buffer.from('real raw package bytes');
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
      body: bytes,
    });
    assert.equal(upload.status, 201);
    const uploaded = (await upload.json()).artifact;
    assert.equal(uploaded.digest, crypto.createHash('sha256').update(bytes).digest('hex'));

    assert.equal((await fetch(
      `${baseUrl}/v1/extensions/publisher/releases/web-miniapp/acme-labs/offline-notes/1.0.0/submit`,
      { method: 'POST', headers: ownerJson },
    )).status, 200);

    const prematureApproval = await fetch(
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
    assert.equal(prematureApproval.status, 400);
    assert.equal((await prematureApproval.json()).error.code, 'ARTIFACT_SCAN_REQUIRED');

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

    const download = await fetch(`${baseUrl}/v1/extensions/artifacts/${uploaded.digest}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('etag'), `"${uploaded.digest}"`);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  });
});


test('revoked signing key immediately quarantines approved artifact download', () => {
  const scope = fixture();
  try {
    const bytes = Buffer.from('trusted then revoked bytes');
    const artifact = scope.artifactStore.upload({
      actorAccountId: 'user:owner',
      ...key(),
      artifactId: 'package',
      platform: 'all',
      format: 'fabapp',
      bytes,
    });
    scope.artifactStore.recordScan({
      reviewer: 'security-reviewer',
      ...key(),
      artifactId: 'package',
      state: 'passed',
      scanner: 'fabushi-static-scan',
      scannerVersion: '1.0.0',
    });
    scope.releaseStore.submit({ actorAccountId: 'user:owner', ...key() });
    scope.releaseStore.review({
      ...key(),
      approved: true,
      reviewer: 'security-reviewer',
    });

    const firstSigner = signer('marketplace-key-1', 1);
    const firstSigningStore = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: firstSigner,
      now: () => 1_000,
    });
    const release = scope.releaseStore.getRelease(key());
    firstSigningStore.signRelease({
      descriptor: release.descriptor,
      descriptorDigest: release.descriptorDigest,
      artifacts: scope.artifactStore.listForRelease(key()),
    });
    scope.releaseStore.setSigningStore(firstSigningStore);
    scope.artifactStore.setSigningStore(firstSigningStore);
    assert.equal(scope.artifactStore.approvedArtifact(artifact.digest)?.digest, artifact.digest);

    const rotatedSigningStore = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: signer('marketplace-key-2', 2),
      now: () => 2_000,
    });
    rotatedSigningStore.revokeTrustKey({
      keyId: firstSigner.keyId,
      trustEpoch: firstSigner.trustEpoch,
      reason: 'security incident',
    });
    scope.releaseStore.setSigningStore(rotatedSigningStore);
    scope.artifactStore.setSigningStore(rotatedSigningStore);

    assert.equal(scope.artifactStore.approvedArtifact(artifact.digest), null);
    assert.equal(scope.releaseStore.listApprovedLatest().length, 0);
  } finally {
    scope.close();
  }
});
