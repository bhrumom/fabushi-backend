import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountSyncStore } from '../src/account_sync_store.js';
import {
  canonicalReleaseSignaturePayload,
  ExtensionSigningStore,
  ExtensionSigningStoreError,
  loadConfiguredMarketplaceSigner,
  verifyReleaseSignatureEnvelope,
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
