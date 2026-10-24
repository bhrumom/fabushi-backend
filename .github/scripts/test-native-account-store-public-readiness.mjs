import assert from 'node:assert/strict';
import test from 'node:test';
import { checkNativeAccountStorePublic, checkNativeJournalPublic } from './native-account-store-public-readiness.mjs';

function denied(status = 401, owner = 'existing-node-account-store') {
  return new Response(JSON.stringify({ error: { code: 'ACCOUNT_AUTH_REQUIRED' } }), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-fabushi-agent-store-owner': owner },
  });
}
test('checks both fixed owners without credentials or mutations', async () => {
  const checks = await checkNativeAccountStorePublic(async (url, options) => {
    assert.ok(url.startsWith('https://api.ombhrum.com/') || url.startsWith('https://ai.ombhrum.com/'));
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    return denied();
  });
  assert.equal(checks.length, 10);
});
test('native journal probes require canonical 401s without any credentials or valid run bodies', async () => {
  const checks = await checkNativeJournalPublic(async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.ombhrum.com');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, undefined);
    if (options.method !== 'GET') assert.equal(options.body, '{}');
    else assert.equal(options.body, undefined);
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401,
      headers: { 'content-type': 'application/json', 'x-fabushi-control-plane': 'mahayana-platform' } });
  });
  assert.equal(checks.length, 9);
  for (const status of [200, 400, 404, 500]) {
    await assert.rejects(checkNativeJournalPublic(async () => new Response('{}', { status,
      headers: { 'content-type': 'application/json', 'x-fabushi-control-plane': 'mahayana-platform' } })));
  }
});
test('rejects missing route, false success, foreign owner and redirect', async () => {
  for (const response of [denied(404), denied(200), denied(401, 'other-owner'), new Response(null, { status: 302, headers: { location: 'https://example.com' } })]) {
    await assert.rejects(checkNativeAccountStorePublic(async () => response));
  }
});
