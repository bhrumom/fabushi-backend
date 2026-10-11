import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountSyncStore } from '../src/account_sync_store.js';
import {
  canonicalFabAppSigningPayload,
  canonicalReleaseSignaturePayload,
  ExtensionSigningStore,
  ExtensionSigningStoreError,
  loadConfiguredMarketplaceSigner,
  verifyReleaseSignatureEnvelope,
  verifyTrustFeedEnvelope,
} from '../src/extension_signing_store.js';

function signer(keyId = 'marketplace-test-1', trustEpoch = 1) {
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

function descriptor() {
  return {
    id: 'acme-labs/offline-notes:web-miniapp',
    identity: {
      namespace: 'acme-labs',
      name: 'offline-notes',
      kind: 'web-miniapp',
    },
    release: { version: '1.0.0' },
  };
}

function artifacts() {
  return [{
    artifactId: 'universal-ui',
    digest: 'a'.repeat(64),
    sizeBytes: 42,
    platform: 'all',
    architecture: 'any',
    format: 'fabapp',
    scan: { state: 'passed' },
  }];
}

function dbFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-signing-'));
  const accountStore = new AccountSyncStore({ dbPath: path.join(root, 'marketplace.sqlite') });
  return {
    root,
    accountStore,
    close() {
      accountStore.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('production signer config is all-or-nothing and requires Ed25519', () => {
  assert.equal(loadConfiguredMarketplaceSigner({}), null);
  assert.throws(
    () => loadConfiguredMarketplaceSigner({
      FABUSHI_MARKETPLACE_SIGNING_KEY_ID: 'key-only',
    }),
    (error) => error instanceof ExtensionSigningStoreError
      && error.code === 'INCOMPLETE_SIGNING_CONFIGURATION',
  );

  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs8', format: 'pem' });
  assert.throws(
    () => loadConfiguredMarketplaceSigner({
      FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY: rsa,
      FABUSHI_MARKETPLACE_SIGNING_KEY_ID: 'rsa-key',
      FABUSHI_MARKETPLACE_TRUST_EPOCH: '1',
    }),
    (error) => error instanceof ExtensionSigningStoreError
      && error.code === 'INVALID_SIGNING_PRIVATE_KEY',
  );
});

test('canonical signature binds descriptor digest, artifact digests, key id and trust epoch', () => {
  const activeSigner = signer('key-7', 9);
  const payload = canonicalReleaseSignaturePayload({
    signer: activeSigner,
    descriptor: descriptor(),
    descriptorDigest: 'b'.repeat(64),
    artifacts: artifacts(),
  });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.protocol, 'fabushi.extension-release-signature.v1');
  assert.equal(parsed.keyId, 'key-7');
  assert.equal(parsed.trustEpoch, 9);
  assert.equal(parsed.descriptorDigest, 'b'.repeat(64));
  assert.equal(parsed.artifacts[0].digest, 'a'.repeat(64));
});

test('stored Ed25519 envelope verifies and tampering fails verification', () => {
  const scope = dbFixture();
  try {
    const store = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: signer(),
      now: () => 123456,
    });
    const envelope = store.signRelease({
      descriptor: descriptor(),
      descriptorDigest: 'b'.repeat(64),
      artifacts: artifacts(),
    });
    assert.equal(envelope.algorithm, 'Ed25519');
    assert.equal(envelope.signedAtMs, 123456);
    assert.equal(verifyReleaseSignatureEnvelope(envelope), true);

    assert.equal(verifyReleaseSignatureEnvelope({
      ...envelope,
      payload: envelope.payload.replace('offline-notes', 'evil-notes'),
    }), false);
    assert.equal(verifyReleaseSignatureEnvelope({
      ...envelope,
      signature: Buffer.from('tampered').toString('base64'),
    }), false);

    assert.deepEqual(store.getSignature({
      kind: 'web-miniapp',
      namespace: 'acme-labs',
      name: 'offline-notes',
      version: '1.0.0',
    }), envelope);
  } finally {
    scope.close();
  }
});

test('a release signature cannot be silently replaced by a new key or trust epoch', () => {
  const scope = dbFixture();
  try {
    const first = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: signer('key-1', 1),
    });
    first.signRelease({
      descriptor: descriptor(),
      descriptorDigest: 'b'.repeat(64),
      artifacts: artifacts(),
    });

    const rotated = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: signer('key-2', 2),
    });
    assert.throws(
      () => rotated.signRelease({
        descriptor: descriptor(),
        descriptorDigest: 'b'.repeat(64),
        artifacts: artifacts(),
      }),
      (error) => error instanceof ExtensionSigningStoreError
        && error.code === 'SIGNATURE_CONFLICT',
    );
  } finally {
    scope.close();
  }
});

test('missing managed signer fails closed instead of generating a trust key', () => {
  const scope = dbFixture();
  try {
    const store = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: null,
    });
    assert.deepEqual(store.currentTrust(), {
      configured: false,
      protocol: 'fabushi.extension-release-signature.v1',
    });
    assert.throws(
      () => store.signRelease({
        descriptor: descriptor(),
        descriptorDigest: 'b'.repeat(64),
        artifacts: artifacts(),
      }),
      (error) => error instanceof ExtensionSigningStoreError
        && error.code === 'SIGNING_KEY_REQUIRED',
    );
  } finally {
    scope.close();
  }
});


test('signed trust feed verifies, rejects tampering, and fails closed after expiry', () => {
  const scope = dbFixture();
  try {
    let nowMs = 10_000;
    const activeSigner = signer('feed-key', 3);
    const store = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: activeSigner,
      now: () => nowMs,
    });
    const envelope = store.trustFeed({ ttlMs: 60_000 });
    assert.equal(envelope.protocol, 'fabushi.extension-trust-feed.v1');
    assert.equal(envelope.keyId, 'feed-key');
    assert.equal(envelope.trustEpoch, 3);
    assert.equal(verifyTrustFeedEnvelope(envelope, { nowMs }), true);

    const payload = JSON.parse(envelope.payload);
    assert.equal(payload.signer.keyId, 'feed-key');
    assert.equal(payload.keys.length, 1);
    assert.equal(payload.keys[0].status, 'active');
    assert.equal(payload.keys[0].publicKey, activeSigner.publicKey);
    assert.doesNotMatch(JSON.stringify(envelope), /PRIVATE KEY|review-token|oauth/i);

    assert.equal(verifyTrustFeedEnvelope({
      ...envelope,
      payload: envelope.payload.replace('"active"', '"revoked"'),
    }, { nowMs }), false);

    nowMs = envelope.expiresAtMs + 1;
    assert.equal(verifyTrustFeedEnvelope(envelope, { nowMs }), false);
    assert.equal(verifyTrustFeedEnvelope(envelope, { nowMs, allowExpired: true }), true);
  } finally {
    scope.close();
  }
});

test('rotation permits revoking an old key while current signer self-revocation fails closed', () => {
  const scope = dbFixture();
  try {
    const firstSigner = signer('marketplace-key-1', 1);
    const first = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: firstSigner,
      now: () => 1_000,
    });
    assert.throws(
      () => first.revokeTrustKey({
        keyId: firstSigner.keyId,
        trustEpoch: firstSigner.trustEpoch,
        reason: 'compromised',
      }),
      (error) => error instanceof ExtensionSigningStoreError
        && error.code === 'ACTIVE_SIGNER_REVOCATION_REQUIRES_ROTATION',
    );

    const rotatedSigner = signer('marketplace-key-2', 2);
    const rotated = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: rotatedSigner,
      now: () => 2_000,
    });
    const revoked = rotated.revokeTrustKey({
      keyId: firstSigner.keyId,
      trustEpoch: firstSigner.trustEpoch,
      reason: 'rotation after compromise',
    });
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.revocationReason, 'rotation after compromise');

    assert.throws(
      () => rotated.revokeTrustKey({
        keyId: firstSigner.keyId,
        trustEpoch: firstSigner.trustEpoch,
      }),
      (error) => error instanceof ExtensionSigningStoreError
        && error.code === 'TRUST_KEY_ALREADY_REVOKED',
    );

    const feed = rotated.trustFeed({ ttlMs: 30_000 });
    assert.equal(verifyTrustFeedEnvelope(feed, { nowMs: 2_000 }), true);
    const feedPayload = JSON.parse(feed.payload);
    assert.deepEqual(
      feedPayload.keys.map((item) => [item.keyId, item.trustEpoch, item.status]),
      [
        ['marketplace-key-1', 1, 'revoked'],
        ['marketplace-key-2', 2, 'active'],
      ],
    );
  } finally {
    scope.close();
  }
});

test('reusing one key id and epoch with different public material fails closed', () => {
  const scope = dbFixture();
  try {
    new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: signer('stable-key', 7),
    });
    assert.throws(
      () => new ExtensionSigningStore({
        db: scope.accountStore.db,
        signer: signer('stable-key', 7),
      }),
      (error) => error instanceof ExtensionSigningStoreError
        && error.code === 'TRUST_KEY_MATERIAL_CONFLICT',
    );
  } finally {
    scope.close();
  }
});

test('trust feed rejects excessive TTL and unreasonable future timestamps', () => {
  const scope = dbFixture();
  try {
    const activeSigner = signer('ttl-key', 1);
    const store = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: activeSigner,
      now: () => 500_000,
    });
    assert.throws(
      () => store.trustFeed({ ttlMs: 8 * 24 * 60 * 60 * 1000 }),
      (error) => error instanceof ExtensionSigningStoreError
        && error.code === 'INVALID_TRUST_FEED_TTL',
    );
    const envelope = store.trustFeed({ ttlMs: 60_000 });
    assert.equal(
      verifyTrustFeedEnvelope(envelope, { nowMs: envelope.issuedAtMs - (6 * 60 * 1000) }),
      false,
    );
  } finally {
    scope.close();
  }
});


function fabAppManifest() {
  return {
    manifestVersion: 1,
    packageClass: 'catalog',
    appId: 'global-dharma',
    publisherId: 'fabushi-official',
    version: '1.1.0',
    displayName: '全球法布施',
    entrypoint: 'index.html',
    runtime: 'web',
    minHostApi: 1,
    offlineCore: true,
    requestedCapabilities: [
      'offline.capabilities',
      'offline.state.read',
      'offline.practice.record',
      'local.prayer-wheel.start',
    ],
    networkPolicy: { mode: 'deny', allowedOrigins: [] },
    files: {
      'index.html': { sha256: 'a'.repeat(64), bytes: 42, mime: 'text/html' },
      'app.js': { sha256: 'b'.repeat(64), bytes: 84, mime: 'text/javascript' },
    },
  };
}

test('fabapp manifest signing matches domain-separated native contract and raw Ed25519 trust', () => {
  const scope = dbFixture();
  try {
    const activeSigner = signer('catalog-key', 11);
    const store = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: activeSigner,
    });
    const unsigned = fabAppManifest();
    const signed = store.signFabAppManifest(unsigned);

    assert.equal(signed.manifest.signature.algorithm, 'Ed25519');
    assert.equal(signed.manifest.signature.keyId, 'catalog-key');
    assert.equal(signed.trust.keyId, 'catalog-key');
    assert.equal(signed.trust.trustEpoch, 11);
    assert.doesNotMatch(JSON.stringify(signed), /PRIVATE KEY/);

    const raw = Buffer.from(signed.trust.rawPublicKeyBase64URL, 'base64url');
    assert.equal(raw.length, 32);
    const publicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: signed.trust.rawPublicKeyBase64URL },
      format: 'jwk',
    });
    assert.equal(
      crypto.verify(
        null,
        canonicalFabAppSigningPayload(unsigned),
        publicKey,
        Buffer.from(signed.manifest.signature.value, 'base64url'),
      ),
      true,
    );

    const tampered = { ...unsigned, version: '1.1.1' };
    assert.equal(
      crypto.verify(
        null,
        canonicalFabAppSigningPayload(tampered),
        publicKey,
        Buffer.from(signed.manifest.signature.value, 'base64url'),
      ),
      false,
    );
  } finally {
    scope.close();
  }
});

test('fabapp signing rejects networked offline manifests, unknown fields and caller signatures', () => {
  const scope = dbFixture();
  try {
    const store = new ExtensionSigningStore({
      db: scope.accountStore.db,
      signer: signer('catalog-key', 1),
    });
    assert.throws(
      () => store.signFabAppManifest({
        ...fabAppManifest(),
        networkPolicy: { mode: 'allowlist', allowedOrigins: ['https://example.com'] },
      }),
      (error) => error instanceof ExtensionSigningStoreError
        && error.code === 'INVALID_FABAPP_MANIFEST',
    );
    assert.throws(
      () => store.signFabAppManifest({ ...fabAppManifest(), extra: true }),
      (error) => error instanceof ExtensionSigningStoreError
        && error.code === 'INVALID_FABAPP_MANIFEST',
    );
    assert.throws(
      () => store.signFabAppManifest({
        ...fabAppManifest(),
        signature: { algorithm: 'Ed25519', keyId: 'attacker', value: 'AA' },
      }),
      (error) => error instanceof ExtensionSigningStoreError
        && error.code === 'INVALID_FABAPP_MANIFEST',
    );
  } finally {
    scope.close();
  }
});

test('fabapp signing fails closed without managed signer', () => {
  const scope = dbFixture();
  try {
    const store = new ExtensionSigningStore({ db: scope.accountStore.db, signer: null });
    assert.throws(
      () => store.signFabAppManifest(fabAppManifest()),
      (error) => error instanceof ExtensionSigningStoreError
        && error.code === 'SIGNING_KEY_REQUIRED',
    );
  } finally {
    scope.close();
  }
});
