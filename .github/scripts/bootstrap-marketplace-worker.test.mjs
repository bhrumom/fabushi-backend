import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { plan, names } from './bootstrap-marketplace-worker.mjs';
function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'bhrumom/fabushi-backend',
    FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW: publicKey.export({ format: 'jwk' }).x,
    FABUSHI_MARKETPLACE_SIGNING_KEY_ID: 'test-only', FABUSHI_MARKETPLACE_TRUST_EPOCH: '1',
    FABUSHI_MARKETPLACE_REVIEW_TOKEN: randomBytes(32).toString('base64url') };
}
test('canonical main and repository mandatory', () => {
  assert.throws(() => plan({ ...fixture(), GITHUB_REF: 'refs/heads/feature' }, []));
  assert.throws(() => plan({ ...fixture(), GITHUB_REPOSITORY: 'untrusted/repo' }, []));
});
test('partial remote configuration cannot be overwritten', () => assert.throws(() => plan(fixture(), [names[0]])));
test('complete remote identity is preserved', () => assert.equal(plan(fixture(), names).action, 'preserve-existing'));
test('missing encrypted config rejects', () => assert.throws(() => plan({ ...fixture(), FABUSHI_MARKETPLACE_REVIEW_TOKEN: '' }, [])));
test('key mismatch rejects', () => assert.throws(() => plan({ ...fixture(), FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW: fixture().FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW }, [])));
test('new identity audit contains public material only', () => {
  const env = fixture(), result = plan(env, []), serialized = JSON.stringify(result);
  assert.equal(result.action, 'initialize');
  assert.equal(result.public.rawPublicKeyBase64URL, env.FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW);
  assert.ok(!serialized.includes(env.FABUSHI_MARKETPLACE_REVIEW_TOKEN));
  assert.ok(!serialized.includes('PRIVATE KEY'));
});
