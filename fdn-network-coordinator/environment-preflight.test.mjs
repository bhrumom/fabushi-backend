import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

function launch(stateKey) {
  return spawnSync('bash', ['fdn-network-coordinator/run-enrollment-service.sh'], {
    encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH,
      FDN_NETWORK_AUTHORITY_TOKEN: 'a'.repeat(64),
      FABUSHI_FDN_ENROLLMENT_BROKER_TOKEN: 'b'.repeat(64),
      FABUSHI_FDN_ENROLLMENT_STATE_KEY_B64: stateKey,
      FABUSHI_PLATFORM_CORE_URL: 'https://isolated.invalid',
      // Stop at the next guard; no Docker invocation, files or network request.
      DOCKER_HOST: 'unix:///var/run/docker.sock' },
  });
}
test('valid32-byte AES key passes key guard despite44-character encoding', () => {
  const key = randomBytes(32).toString('base64');
  assert.equal(key.length, 44);
  const result = launch(key);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /dedicated rootless Docker/);
  assert.doesNotMatch(result.stderr, /canonical base64/);
});
for (const [name, key] of [['missing', ''], ['wrong-size', Buffer.alloc(31).toString('base64')], ['trailing-junk', Buffer.alloc(32).toString('base64') + 'invalid'], ['non-base64', '!'.repeat(64)]]) {
  test(`${name} key rejects before external service execution`, () => {
    const result = launch(key);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /canonical base64/);
    assert.doesNotMatch(result.stderr, /dedicated rootless Docker/);
  });
}
