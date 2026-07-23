import assert from 'node:assert/strict';
import test from 'node:test';

import { generateToken } from '../auth-utils.js';
import { ADMIN_EMAIL } from '../src/config/constants.js';
import {
  handleMarketplaceBrowse,
  handleMarketplacePublish,
} from '../src/handlers/marketplace.js';

function statement(sql, calls, result = null) {
  return {
    bind(...values) {
      calls.push({ sql, values });
      return {
        async first() { return result; },
        async all() { return result || { results: [] }; },
      };
    },
    async all() { return result || { results: [] }; },
  };
}

test('marketplace browse returns exact immutable download metadata', async () => {
  const calls = [];
  const env = {
    PLATFORM_DB: {
      prepare(sql) {
        return statement(sql, calls, {
          results: [{
            plugin_id: 'chatgpt-auto-confirm',
            display_name: 'ChatGPT Auto Confirm',
            description: 'Scoped desktop approvals',
            latest_version: '0.1.0',
            platforms_json: '["cli","desktop"]',
            package_key: 'https://chatgpt-auto-confirm.example',
            package_sha256: 'abc123',
            package_size: 42,
          }],
        });
      },
    },
  };
  const response = await handleMarketplaceBrowse(
    new Request('https://api.example/v1/marketplace/plugins?q=chatgpt&platform=desktop'),
    env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.plugins[0].pluginId, 'chatgpt-auto-confirm');
  assert.equal(payload.plugins[0].latestVersion, '0.1.0');
  assert.equal(
    payload.plugins[0].downloadUrl,
    'https://chatgpt-auto-confirm.example/mahayana/plugin.tar.gz',
  );
  assert.match(calls[0].sql, /review_state = 'approved'/);

  const mobileResponse = await handleMarketplaceBrowse(
    new Request('https://api.example/v1/marketplace/plugins?q=chatgpt&platform=mobile'),
    env,
  );
  assert.deepEqual((await mobileResponse.json()).plugins, []);
});

test('admin publication verifies a hashed independent deployment and returns a receipt', async () => {
  const secretEnv = { JWT_SECRET: 'marketplace-test-secret' };
  const token = await generateToken({ id: 7, username: 'publisher' }, secretEnv);
  const calls = [];
  const prepared = [];
  const env = {
    ...secretEnv,
    PLATFORM_DB: {
      prepare(sql) {
        const preparedStatement = {
          sql,
          bind(...values) {
            calls.push({ sql, values });
            return {
              sql,
              values,
              async first() { return null; },
            };
          },
        };
        prepared.push(preparedStatement);
        return preparedStatement;
      },
      async batch(statements) {
        assert.equal(statements.length, 2);
        return [{ success: true }, { success: true }];
      },
    },
  };
  const accountDb = {
    async getUser(username) {
      assert.equal(username, 'publisher');
      return { id: 7, username, email: ADMIN_EMAIL };
    },
  };
  const form = new FormData();
  form.set('pluginId', 'chatgpt-auto-confirm');
  form.set('version', '0.1.0');
  form.set('deploymentUrl', 'https://chatgpt-auto-confirm.example');
  form.set('platforms', '["cli","desktop"]');
  const packageBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
  const digest = await crypto.subtle.digest('SHA-256', packageBytes);
  const packageSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  form.set('packageSha256', packageSha256);
  form.set('packageSize', String(packageBytes.byteLength));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://chatgpt-auto-confirm.example/mahayana/plugin.tar.gz');
    return new Response(packageBytes, { status: 200, headers: { 'Content-Type': 'application/gzip' } });
  };
  let response;
  try {
    response = await handleMarketplacePublish(new Request(
      'https://api.example/v1/marketplace/releases',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
    ), env, accountDb);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.status, 'published');
  assert.equal(receipt.reviewState, 'approved');
  assert.equal(receipt.pluginId, 'chatgpt-auto-confirm');
  assert.equal(receipt.packageSize, 4);
  assert.match(receipt.packageSha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.deploymentUrl, 'https://chatgpt-auto-confirm.example');
  assert.deepEqual(receipt.platforms, ['cli', 'desktop']);
  assert.equal(
    receipt.downloadUrl,
    'https://chatgpt-auto-confirm.example/mahayana/plugin.tar.gz',
  );
  assert.equal(calls.length, 4);
});

test('publication rejects invalid deployment metadata before fetching', async () => {
  const secretEnv = { JWT_SECRET: 'marketplace-test-secret' };
  const token = await generateToken({ id: 8, username: 'publisher' }, secretEnv);
  const form = new FormData();
  form.set('pluginId', 'unsafe-package');
  form.set('version', '1.0.0');
  form.set('deploymentUrl', 'http://localhost:8787');
  form.set('platforms', '["desktop"]');
  form.set('packageSha256', 'not-a-sha');
  form.set('packageSize', '8');
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; return new Response(); };
  const response = await handleMarketplacePublish(new Request(
    'https://api.example/v1/marketplace/releases',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
  ), {
    ...secretEnv,
    PLATFORM_DB: {},
  }, {
    async getUser() { return { id: 8, email: ADMIN_EMAIL }; },
  });
  globalThis.fetch = originalFetch;
  assert.equal(response.status, 400);
  assert.equal(fetched, false);
});
