import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';

import { resolveDelegatedPluginIdentity } from '../src/delegated_plugin_identity.js';

const workspace = process.env.GITHUB_WORKSPACE
  ? resolve(process.env.GITHUB_WORKSPACE)
  : resolve(new URL('../..', import.meta.url).pathname);

test('delegated Mini App identity uses server introspection without exposing the credential', async () => {
  const calls = [];
  const identity = await resolveDelegatedPluginIdentity({
    token: 'delegated-secret',
    pluginId: 'global-dharma',
    apiBaseUrl: 'https://api.example.test/',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { active: true, sessionBound: true, pluginId: 'global-dharma', user: { id: '42' } };
        },
      };
    },
  });
  assert.deepEqual(identity, { pluginId: 'global-dharma', userId: '42' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/auth/plugin-token/introspect');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer delegated-secret');
  assert.deepEqual(JSON.parse(calls[0].options.body), { pluginId: 'global-dharma' });
  assert.doesNotMatch(JSON.stringify(identity), /delegated-secret/);
});

test('delegated Mini App identity fails closed on inactive or mismatched projection', async () => {
  for (const payload of [
    { active: false, sessionBound: true, pluginId: 'global-dharma', user: { id: '42' } },
    { active: true, sessionBound: true, pluginId: 'other-app', user: { id: '42' } },
    { active: true, sessionBound: false, pluginId: 'global-dharma', user: { id: '42' } },
  ]) {
    const identity = await resolveDelegatedPluginIdentity({
      token: 'delegated-secret',
      pluginId: 'global-dharma',
      apiBaseUrl: 'https://api.example.test',
      fetchImpl: async () => ({ ok: true, async json() { return payload; } }),
    });
    assert.equal(identity, null);
  }
});

test('Platform Worker delegated token is sid-bound, exact-scope, introspectable and entitlement-only', () => {
  const identity = readFileSync(join(workspace, 'third_party/mahayana/mahayana-rs/mahayana-platform-core/src/identity.rs'), 'utf8');
  const router = readFileSync(join(workspace, 'third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/worker_api.rs'), 'utf8');
  const account = readFileSync(join(workspace, 'third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/worker_api/account.rs'), 'utf8');
  const commerce = readFileSync(join(workspace, 'third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/worker_api/commerce.rs'), 'utf8');
  const server = readFileSync(join(workspace, 'ai-backend/src/server.js'), 'utf8');
  assert.match(identity, /struct PluginAccessTokenClaims[\s\S]*pub sid: String/);
  assert.match(router, /\/v1\/auth\/plugin-token\/introspect/);
  assert.match(account, /account_sessions[\s\S]*revoked_at[\s\S]*authenticated_plugin_account/);
  assert.match(account, /validation\.set_audience[\s\S]*miniapp:/);
  assert.match(commerce, /authenticated_session_account/);
  assert.match(commerce, /delegated token must contain only the matching Mini App scope/);
  assert.match(commerce, /commerce_entitlement[\s\S]*authenticated_plugin_account/);
  assert.match(server, /resolveDelegatedPluginIdentity[\s\S]*delegatedIdentity\.userId/);
  assert.doesNotMatch(commerce, /authenticated_plugin_account[\s\S]{0,400}commerce_purchase/);
});
