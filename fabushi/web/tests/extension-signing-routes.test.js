import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { routeExtensionSigningRequest, __test } from '../src/routes/extension-signing-routes.js';

function fixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    env: {
      FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW: publicKey.export({ format: 'jwk' }).x,
      FABUSHI_MARKETPLACE_SIGNING_KEY_ID: 'marketplace-test-key',
      FABUSHI_MARKETPLACE_TRUST_EPOCH: '7',
      FABUSHI_MARKETPLACE_REVIEW_TOKEN: 'review-token-0123456789',
    },
    manifest: {
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
      },
    },
  };
}

test('Worker fabapp signer produces a self-verifying native-compatible Ed25519 envelope', async () => {
  const { env, manifest } = fixture();
  const signed = await __test.signManifest(env, manifest);
  assert.equal(signed.manifest.signature.algorithm, 'Ed25519');
  assert.equal(signed.manifest.signature.keyId, 'marketplace-test-key');
  assert.equal(signed.trust.keyId, 'marketplace-test-key');
  assert.equal(signed.trust.trustEpoch, 7);
  assert.equal(Buffer.from(signed.trust.rawPublicKeyBase64URL, 'base64url').length, 32);

  const unsigned = { ...signed.manifest };
  delete unsigned.signature;
  const payload = Buffer.concat([
    Buffer.from('fabushi.fabapp.manifest.v1\0'),
    Buffer.from(__test.canonicalJson(unsigned)),
  ]);
  const publicKey = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: signed.trust.rawPublicKeyBase64URL },
    format: 'jwk',
  });
  assert.equal(
    crypto.verify(
      null,
      payload,
      publicKey,
      Buffer.from(signed.manifest.signature.value, 'base64url'),
    ),
    true,
  );
});

test('Worker route requires reviewer auth, exposes public trust and rejects networked offline manifests', async () => {
  const { env, manifest } = fixture();
  const trustResponse = await routeExtensionSigningRequest({
    pathname: '/v1/extensions/trust',
    method: 'GET',
    request: new Request('https://api.example/v1/extensions/trust'),
    env,
  });
  assert.equal(trustResponse.status, 200);
  const trust = await trustResponse.json();
  assert.equal(trust.trust.keyId, 'marketplace-test-key');

  const denied = await routeExtensionSigningRequest({
    pathname: '/v1/extensions/review/fabapp/sign',
    method: 'POST',
    request: new Request('https://api.example/v1/extensions/review/fabapp/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    }),
    env,
  });
  assert.equal(denied.status, 403);

  const accepted = await routeExtensionSigningRequest({
    pathname: '/v1/extensions/review/fabapp/sign',
    method: 'POST',
    request: new Request('https://api.example/v1/extensions/review/fabapp/sign', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fabushi-marketplace-review-token': env.FABUSHI_MARKETPLACE_REVIEW_TOKEN,
      },
      body: JSON.stringify({ manifest }),
    }),
    env,
  });
  assert.equal(accepted.status, 200);

  const invalid = await routeExtensionSigningRequest({
    pathname: '/v1/extensions/review/fabapp/sign',
    method: 'POST',
    request: new Request('https://api.example/v1/extensions/review/fabapp/sign', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fabushi-marketplace-review-token': env.FABUSHI_MARKETPLACE_REVIEW_TOKEN,
      },
      body: JSON.stringify({
        manifest: {
          ...manifest,
          networkPolicy: { mode: 'allowlist', allowedOrigins: ['https://example.com'] },
        },
      }),
    }),
    env,
  });
  assert.equal(invalid.status, 400);
  const error = await invalid.json();
  assert.equal(error.error, 'INVALID_FABAPP_MANIFEST');
});

test('Worker signer fails closed on incomplete production signing configuration', async () => {
  const { env } = fixture();
  delete env.FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW;
  const response = await routeExtensionSigningRequest({
    pathname: '/v1/extensions/trust',
    method: 'GET',
    request: new Request('https://api.example/v1/extensions/trust'),
    env,
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'SIGNING_CONFIGURATION_REQUIRED');
});
