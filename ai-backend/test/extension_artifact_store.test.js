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

    for (const binding of [
      { expectedDigest: '0'.repeat(64) },
      { expectedSizeBytes: 999 },
      { expectedSizeBytes: '13' },
    ]) {
      assert.throws(() => scope.artifactStore.recordScan({
        reviewer: 'security-reviewer', ...key(), artifactId: 'package',
        state: 'passed', scanner: 'fabushi-static-scan', scannerVersion: '1.0.0',
        ...binding,
      }), (error) => error.code === 'ARTIFACT_BINDING_CONFLICT');
      assert.equal(scope.artifactStore.listForRelease(key())[0].scan.state, 'pending');
    }
    const passed = scope.artifactStore.recordScan({
      reviewer: 'security-reviewer',
      ...key(),
      artifactId: 'package',
      state: 'passed',
      scanner: 'fabushi-static-scan',
      scannerVersion: '1.0.0',
      expectedDigest: crypto.createHash('sha256').update('scanned bytes').digest('hex'),
      expectedSizeBytes: Buffer.byteLength('scanned bytes'),
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

const MIRROR_URL = 'https://github.com/bhrumom/global-dandelion-rs/releases/download/v0.2.0/global-dandelion.fabapp';

function signedPayload(scope, artifacts) {
  const release = scope.releaseStore.getRelease(key());
  const signingStore = new ExtensionSigningStore({
    db: scope.accountStore.db,
    signer: signer('marketplace-key-1', 1),
    now: () => 1_000,
  });
  return JSON.parse(signingStore.signRelease({
    descriptor: release.descriptor,
    descriptorDigest: release.descriptorDigest,
    artifacts,
  }).payload);
}

test('registry hosted artifacts keep the canonical payload free of a url field', () => {
  const scope = fixture();
  try {
    scope.artifactStore.upload({
      actorAccountId: 'user:owner',
      ...key(),
      artifactId: 'package',
      platform: 'all',
      format: 'fabapp',
      bytes: Buffer.from('registry bytes'),
    });
    const [artifact] = scope.artifactStore.listForRelease(key());
    assert.equal(artifact.url, '');
    const payload = signedPayload(scope, scope.artifactStore.listForRelease(key()));
    assert.equal(Object.hasOwn(payload.artifacts[0], 'url'), false);
    assert.deepEqual(Object.keys(payload.artifacts[0]), [
      'artifactId', 'digest', 'sizeBytes', 'platform', 'architecture', 'format',
    ]);
  } finally {
    scope.close();
  }
});

test('mirror hosted artifacts register metadata only and sign the download url', () => {
  const scope = fixture();
  try {
    const bytes = Buffer.from('github hosted package bytes');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const artifact = scope.artifactStore.registerExternal({
      actorAccountId: 'user:owner',
      ...key(),
      artifactId: 'package',
      platform: 'all',
      format: 'fabapp',
      digest,
      sizeBytes: bytes.length,
      url: MIRROR_URL,
    });
    assert.equal(artifact.digest, digest);
    assert.equal(artifact.sizeBytes, bytes.length);
    assert.equal(artifact.url, MIRROR_URL);
    assert.equal(artifact.scan.state, 'pending');

    // The registry never stores the bytes for an externally hosted artifact.
    assert.equal(
      fs.existsSync(path.join(scope.root, 'extensions', 'artifacts', 'sha256', digest.slice(0, 2), digest)),
      false,
    );

    const payload = signedPayload(scope, scope.artifactStore.listForRelease(key()));
    assert.equal(payload.artifacts[0].url, MIRROR_URL);
    assert.equal(payload.artifacts[0].digest, digest);
  } finally {
    scope.close();
  }
});

test('mirror urls are restricted to approved https release hosts', () => {
  const scope = fixture();
  try {
    const digest = crypto.createHash('sha256').update(Buffer.from('x')).digest('hex');
    const rejected = [
      'http://github.com/a/b/releases/download/v1/x.fabapp',
      'https://raw.githubusercontent.com/a/b/main/x.fabapp',
      'https://github.com.evil.example/a/b',
      'https://user:pass@github.com/a/b',
      'https://github.com:8443/a/b',
      'https://github.com/a/b#fragment',
      '',
      'not a url',
    ];
    for (const url of rejected) {
      assert.throws(
        () => scope.artifactStore.registerExternal({
          actorAccountId: 'user:owner',
          ...key(),
          artifactId: 'package',
          platform: 'all',
          format: 'fabapp',
          digest,
          sizeBytes: 1,
          url,
        }),
        (error) => error instanceof ExtensionArtifactStoreError
          && error.code === 'INVALID_ARTIFACT_URL',
        url,
      );
    }
  } finally {
    scope.close();
  }
});

test('external registration binds digest immutably and requires an approved mirror', () => {
  const scope = fixture();
  try {
    const bytes = Buffer.from('stable bytes');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    scope.artifactStore.registerExternal({
      actorAccountId: 'user:owner',
      ...key(),
      artifactId: 'package',
      platform: 'all',
      format: 'fabapp',
      digest,
      sizeBytes: bytes.length,
      url: MIRROR_URL,
    });
    assert.throws(
      () => scope.artifactStore.registerExternal({
        actorAccountId: 'user:owner',
        ...key(),
        artifactId: 'package',
        platform: 'all',
        format: 'fabapp',
        digest: crypto.createHash('sha256').update(Buffer.from('other')).digest('hex'),
        sizeBytes: bytes.length,
        url: MIRROR_URL,
      }),
      (error) => error instanceof ExtensionArtifactStoreError
        && error.code === 'ARTIFACT_BINDING_CONFLICT',
    );

    // Re-pointing the mirror is allowed while the release is still mutable.
    const moved = scope.artifactStore.attachUrl({
      actorAccountId: 'user:owner',
      ...key(),
      artifactId: 'package',
      url: 'https://github.com/bhrumom/global-dandelion-rs/releases/download/v0.2.1/global-dandelion.fabapp',
    });
    assert.equal(
      moved.url,
      'https://github.com/bhrumom/global-dandelion-rs/releases/download/v0.2.1/global-dandelion.fabapp',
    );

    // Once reviewed, the signed location is frozen with the artifact.
    scope.artifactStore.recordScan({
      reviewer: 'security-reviewer',
      ...key(),
      artifactId: 'package',
      state: 'passed',
      scanner: 'fabushi-static-scan',
      scannerVersion: '1.0.0',
    });
    scope.releaseStore.submit({ actorAccountId: 'user:owner', ...key() });
    scope.releaseStore.review({ ...key(), approved: true, reviewer: 'security-reviewer' });
    assert.throws(
      () => scope.artifactStore.attachUrl({
        actorAccountId: 'user:owner',
        ...key(),
        artifactId: 'package',
        url: MIRROR_URL,
      }),
      (error) => error instanceof ExtensionArtifactStoreError
        && error.code === 'ARTIFACT_RELEASE_FROZEN',
    );
  } finally {
    scope.close();
  }
});

test('reviewers can bind externally hosted bytes without impersonating the publisher', () => {
  const scope = fixture();
  try {
    const bytes = Buffer.from('delivery pipeline bytes');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');

    assert.throws(
      () => scope.artifactStore.registerExternal({
        actorAccountId: 'user:reviewer',
        ...key(),
        artifactId: 'package',
        platform: 'all',
        format: 'fabapp',
        digest,
        sizeBytes: bytes.length,
        url: MIRROR_URL,
      }),
      /owned by another account/,
    );

    assert.throws(
      () => scope.artifactStore.registerExternalForReview({
        reviewer: '',
        ...key(),
        artifactId: 'package',
        platform: 'all',
        format: 'fabapp',
        digest,
        sizeBytes: bytes.length,
        url: MIRROR_URL,
      }),
      (error) => error instanceof ExtensionArtifactStoreError
        && error.code === 'REVIEW_AUTH_REQUIRED',
    );

    const artifact = scope.artifactStore.registerExternalForReview({
      reviewer: 'security-reviewer',
      ...key(),
      artifactId: 'package',
      platform: 'all',
      format: 'fabapp',
      digest,
      sizeBytes: bytes.length,
      url: MIRROR_URL,
    });
    assert.equal(artifact.digest, digest);
    assert.equal(artifact.url, MIRROR_URL);

    const last = scope.accountStore.db
      .prepare(`SELECT action, actor FROM extension_artifact_audit
        WHERE digest = ? ORDER BY sequence DESC LIMIT 1`)
      .get(digest);
    assert.equal(last.action, 'artifact.registered');
    assert.equal(last.actor, 'review:security-reviewer');
  } finally {
    scope.close();
  }
});
