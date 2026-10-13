import test from 'node:test';
import assert from 'node:assert/strict';
import { routeExtensionRegistryGateway } from '../src/routes/extension-registry-gateway.js';

test('canonical Registry forwards unchanged account/reviewer headers and body to existing owner', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (request, options) => {
      calls++;
      assert.equal(request.url, 'https://ai.ombhrum.com/v1/extensions/publisher/releases');
      assert.equal(request.headers.get('authorization'), 'Bearer ephemeral-fixture');
      assert.equal(request.headers.get('x-fabushi-marketplace-review-token'), 'fixture-review');
      assert.deepEqual(await request.json(), { version: '1.0.0' });
      assert.equal(options.redirect, 'manual');
      return new Response('{"release":{}}', { status: 201 });
    };
    const request = new Request('https://api.ombhrum.com/v1/extensions/publisher/releases', {
      method: 'POST', headers: { authorization: 'Bearer ephemeral-fixture', 'x-fabushi-marketplace-review-token': 'fixture-review' },
      body: JSON.stringify({ version: '1.0.0' }),
    });
    const response = await routeExtensionRegistryGateway({ pathname: new URL(request.url).pathname, request });
    assert.equal(response.status, 201);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test('other canonical platform paths remain untouched', async () => {
  assert.equal(await routeExtensionRegistryGateway({ pathname: '/v1/marketplace/plugins' }), null);
  assert.equal(await routeExtensionRegistryGateway({ pathname: '/v1/extensions-malicious' }), null);
});
test('uncertain mutation failure does not retry or change authority', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('fixture network failure'); };
    const request = new Request('https://api.ombhrum.com/v1/extensions/publisher/releases', { method: 'POST', body: '{}' });
    const response = await routeExtensionRegistryGateway({ pathname: new URL(request.url).pathname, request });
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
