import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { readExtensionInstallProof } from '../src/extension_install_proof.js';
import { normalizeExtensionEntry } from '../src/extension_registry.js';
import { canonicalReleaseSignaturePayload, verifyReleaseSignatureEnvelope } from '../src/extension_signing_store.js';

function fixture() {
  const key = { kind: 'web-miniapp', namespace: 'test-publisher', name: 'offline-app', version: '0.1.0' };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const signer = { privateKey, keyId: 'test-only', trustEpoch: 1,
    publicKey: der.toString('base64'), publicKeyFingerprint: crypto.createHash('sha256').update(der).digest('hex') };
  const descriptor = normalizeExtensionEntry({ identity: key, origin: 'public', trustDomain: 'catalog-authorized',
    displayName: '离线应用', publisher: { id: key.namespace },
    release: { version: key.version, channel: 'preview', platforms: ['desktop'], bundleDigest: 'a'.repeat(64) },
    runtime: { appId: 'org.test.offline', offlineCore: true } });
  const release = { state: 'approved', descriptor,
    descriptorDigest: crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
    reviewNotes: 'private fixture reviewer note', publisherAccountId: 'private fixture account' };
  const artifacts = [{ artifactId: 'desktop-fabapp', digest: 'a'.repeat(64), sizeBytes: 42,
    platform: 'desktop', architecture: 'any', format: 'fabapp', scan: { state: 'passed' } }];
  const payload = canonicalReleaseSignaturePayload({ signer, descriptor, descriptorDigest: release.descriptorDigest, artifacts });
  const signature = { protocol: 'fabushi.extension-release-signature.v1', algorithm: 'Ed25519',
    keyId: signer.keyId, trustEpoch: 1, publicKey: signer.publicKey, publicKeyFingerprint: signer.publicKeyFingerprint,
    payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64'), signedAtMs: Date.now() };
  let trusted = true;
  const stores = {
    releaseStore: { getRelease: () => release },
    artifactStore: { approvalGate: () => {
      if (artifacts.some((artifact) => artifact.scan.state !== 'passed')) throw new Error('scan required');
      return artifacts;
    } },
    signingStore: { getTrustedSignature: () => trusted && verifyReleaseSignatureEnvelope(signature) ? signature : null,
      trustFeed: () => ({ protocol: 'fixture-feed', publicKey: signer.publicKey }) },
  };
  return { key, stores, release, signature, artifacts, revoke() { trusted = false; } };
}
test('approved proof carries exact signed descriptor bytes without private release fields', () => {
  const f = fixture(), proof = readExtensionInstallProof(f.stores, f.key);
  assert.equal(proof.protocol, 'fabushi.extension-install-proof.v1');
  assert.deepEqual(JSON.parse(proof.descriptorPayload), proof.descriptor);
  assert.equal(crypto.createHash('sha256').update(proof.descriptorPayload).digest('hex'), JSON.parse(proof.releaseSignature.payload).descriptorDigest);
  assert.equal(verifyReleaseSignatureEnvelope(proof.releaseSignature), true);
  assert.equal(JSON.stringify(proof).includes('private fixture'), false);
});
test('draft, pending, rejected and revoked releases expose no install proof', () => {
  for (const state of ['draft', 'pending_review', 'rejected', 'revoked']) {
    const f = fixture(); f.release.state = state;
    assert.throws(() => readExtensionInstallProof(f.stores, f.key), (error) => error.code === 'EXTENSION_NOT_FOUND');
  }
  const f = fixture(); f.revoke();
  assert.throws(() => readExtensionInstallProof(f.stores, f.key), /unavailable/);
});
test('descriptor, artifact binding and signatures cannot be swapped', () => {
  for (const mutate of [
    (f) => { f.release.descriptor.displayName = 'changed'; },
    (f) => { f.artifacts[0].digest = 'b'.repeat(64); },
    (f) => { f.artifacts[0].sizeBytes = 43; },
    (f) => { f.artifacts[0].platform = 'ios'; },
    (f) => { f.artifacts[0].scan.state = 'rejected'; },
    (f) => { f.signature.signature = 'invalid'; },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => readExtensionInstallProof(f.stores, f.key), /unavailable/);
  }
});
