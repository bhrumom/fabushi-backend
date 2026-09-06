import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createMiniAppMarketplaceRouter } from '../src/miniapp_marketplace_http.js';

async function json(response) {
  const payload = await response.json();
  assert.ok(response.ok, JSON.stringify(payload));
  return payload;
}

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-global-dharma-http-'));
  const accounts = new Map([
    ['session-a', { userId: 'user:108', username: 'same-user', isAuthenticated: true }],
    ['session-b', { userId: 'user:108', username: 'same-user', isAuthenticated: true }],
    ['other-session', { userId: 'user:999', username: 'other-user', isAuthenticated: true }],
  ]);
  const resolveUser = async (req) => {
    const token = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const user = accounts.get(token);
    if (!user) return { userId: 'anon:test', isAuthenticated: false };
    return user;
  };
  const fetchImpl = async (url, options = {}) => {
    assert.match(String(url), /\/v1\/plugins\/global-dharma\/entitlements\/local\.prayer-wheel\.start$/);
    assert.match(String(options.headers?.Authorization ?? ''), /^Bearer session-/);
    return new Response(JSON.stringify({
      entitlement: null,
      access: { protected: true, allowed: false, reason: 'not_entitled', effectiveExpiresAt: null },
      purchaseOptions: [
        {
          productId: 'prod.global-dharma.local-prayer-wheel.lifetime',
          sku: 'local-prayer-wheel.lifetime',
          displayName: '本地转经轮永久权限',
          productKind: 'digital_durable',
          subscriptionPeriodSeconds: null,
          currency: 'CNY',
          amount: 108000,
          activeRails: ['web_provider'],
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = express();
  const registration = createMiniAppMarketplaceRouter({
    storagePath: path.join(root, 'marketplace.json'),
    dataDir: root,
    resolveUser,
    fetchImpl,
  });
  app.use(registration.router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, registration });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    registration.accountSyncStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const headers = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('Chinese Marketplace discovery/install, controlled account session, runtime recovery, and 1080 entitlement projection compose in one journey', async () => {
  await withServer(async ({ baseUrl, registration }) => {
    const catalog = await json(await fetch(`${baseUrl}/v1/marketplace/plugins?q=${encodeURIComponent('全球法布施')}&platform=web`));
    assert.equal(catalog.plugins[0].pluginId, 'global-dharma');
    assert.equal(catalog.plugins[0].displayName, '全球法布施');

    const unauthInstall = await fetch(`${baseUrl}/v1/marketplace/plugins/global-dharma/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'web' }),
    });
    assert.ok(unauthInstall.ok, 'public/local install fallback remains available per AAC-003');

    const added = await json(await fetch(`${baseUrl}/v1/marketplace/plugins/global-dharma/add`, {
      method: 'POST', headers: headers('session-a'), body: JSON.stringify({ platform: 'web' }),
    }));
    assert.equal(added.accountSynchronized, true);
    assert.equal(added.bot.username, 'global_dharma_bot');

    const addedFromSecondSession = await json(await fetch(`${baseUrl}/v1/marketplace/added`, { headers: headers('session-b') }));
    assert.deepEqual(addedFromSecondSession.apps.map((app) => app.id), ['global-dharma']);

    const deniedRuntime = await fetch(`${baseUrl}/v1/miniapps/global-dharma/runtime`);
    assert.equal(deniedRuntime.status, 401);

    const before = await json(await fetch(`${baseUrl}/v1/miniapps/global-dharma/runtime`, { headers: headers('session-b') }));
    assert.equal(before.revision, 0);
    registration.globalDharmaRuntimeStore.runMutation('user:108', {
      operationId: 'journey-start-1',
      toolName: 'start',
      args: {},
      mutate(state) {
        state.running = true;
        state.logs.push('服务已启动');
        return { content: [{ type: 'text', text: 'started' }], structuredContent: {} };
      },
    });
    const delta = await json(await fetch(
      `${baseUrl}/v1/miniapps/global-dharma/runtime/difference?cursor=${encodeURIComponent(before.cursor)}`,
      { headers: headers('session-b') },
    ));
    assert.equal(delta.mode, 'difference');
    assert.equal(delta.events.at(-1).state.running, true);

    const other = await json(await fetch(`${baseUrl}/v1/miniapps/global-dharma/runtime`, { headers: headers('other-session') }));
    assert.equal(other.revision, 0);
    assert.equal(other.state.running, false);

    const entitlement = await json(await fetch(
      `${baseUrl}/v1/miniapps/global-dharma/entitlement/${encodeURIComponent('local.prayer-wheel.start')}`,
      { headers: headers('session-a') },
    ));
    assert.equal(entitlement.access.allowed, false);
    assert.equal(entitlement.access.purchaseOptions[0].currency, 'CNY');
    assert.equal(entitlement.access.purchaseOptions[0].amount, 108000);
    assert.equal(JSON.stringify(entitlement).includes('session-a'), false, 'raw session token must not enter Mini App payload');
  });
});
