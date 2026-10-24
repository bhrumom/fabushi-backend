import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

import { AccountSyncStore } from '../src/account_sync_store.js';
import { createMiniAppMarketplaceRouter } from '../src/miniapp_marketplace_http.js';
import { registerPlatformApi } from '../src/platform_api.js';
import { createNativeAccountJsonParser, MAX_AGENT_OBJECT_BYTES } from '../src/native_account_json.js';

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function withTwoDeviceServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-two-device-sync-'));
  const db = new Database(path.join(root, 'account.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const syncStore = new AccountSyncStore({ db });
  const sessions = new Map([
    ['mac-session-token', { userId: 'user:108', username: 'same-account', isAuthenticated: true }],
    ['iphone-session-token', { userId: 'user:108', username: 'same-account', isAuthenticated: true }],
    ['other-session-token', { userId: 'user:999', username: 'other-account', isAuthenticated: true }],
  ]);
  const resolveUser = async (req) => {
    const token = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const user = sessions.get(token);
    if (!user) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    return user;
  };

  const app = express();
  app.use(createNativeAccountJsonParser());
  registerPlatformApi({ app, db, resolveUser, asyncHandler });
  const marketplace = createMiniAppMarketplaceRouter({
    dataDir: root,
    storagePath: path.join(root, 'marketplace.json'),
    accountSyncStore: syncStore,
    resolveUser,
  });
  app.use(marketplace.router);
  app.use((error, _req, res, _next) => {
    res.status(Number(error?.statusCode) || 500).json({ ok: false, error: { code: error?.code ?? 'internal_error', message: error?.message ?? String(error) } });
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function json(response) {
  const payload = await response.json();
  assert.ok(response.ok, `${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function headers(token, deviceId) {
  return {
    authorization: `Bearer ${token}`,
    'x-fabushi-device-id': deviceId,
    'x-request-id': `${deviceId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'content-type': 'application/json',
  };
}

test('native file HTTP supports empty and 8 MiB files with account and conflict fences', async () => {
  await withTwoDeviceServer(async (baseUrl) => {
    const endpoint = `${baseUrl}/v1/account/agents/native-files/store`;
    const mac = headers('mac-session-token', 'mac-a');
    const iphone = headers('iphone-session-token', 'iphone-b');
    const other = headers('other-session-token', 'other-c');
    const put = (body) => fetch(endpoint, { method: 'PUT', headers: mac, body: JSON.stringify(body) });
    const read = (name, auth = iphone) => fetch(`${endpoint}?path=${encodeURIComponent(name)}`, { headers: auth });
    const empty = await json(await put({ path: 'empty.txt', dataBase64: '', expectAbsent: true }));
    assert.equal((await json(await read('empty.txt'))).dataBase64, '');
    const bytes = Buffer.alloc(MAX_AGENT_OBJECT_BYTES, 173);
    await json(await put({ path: 'max.bin', dataBase64: bytes.toString('base64'), expectAbsent: true }));
    const loaded = await json(await read('max.bin'));
    assert.deepEqual(Buffer.from(loaded.dataBase64, 'base64'), bytes);
    assert.equal((await read('max.bin', other)).status, 404);
    assert.equal((await read('empty.txt', other)).status, 404);

    const conflictResponse = await put({ path: 'empty.txt', dataBase64: 'eA==', baseEtag: 'stale' });
    assert.equal(conflictResponse.status, 409);
    const conflict = await conflictResponse.json();
    assert.equal((await json(await read(conflict.conflictPath))).dataBase64, 'eA==');
    assert.equal((await json(await read('empty.txt'))).etag, empty.etag);
    for (const invalid of [undefined, null, 1, 'Zg', 'Zh==', '====', 'a===', 'Z g==']) {
      assert.equal((await put({ path: 'invalid.bin', dataBase64: invalid })).status, 400);
    }
    assert.equal((await read('invalid.bin')).status, 404);
    assert.equal((await put({ path: 'oversize.bin', dataBase64: Buffer.alloc(MAX_AGENT_OBJECT_BYTES + 1).toString('base64') })).status, 413);
    assert.equal((await read('oversize.bin')).status, 404);
    assert.equal((await fetch(`${baseUrl}/v1/account/agents/native-files`, {
      method: 'PUT', headers: mac, body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    })).status, 413, 'unrelated JSON routes retain their existing 1 MiB limit');
    assert.equal((await put({ path: 'too-large-json.bin', dataBase64: 'A'.repeat(12 * 1024 * 1024) })).status, 413);
    assert.equal((await read('too-large-json.bin')).status, 404);
  });
});

test('two devices with different sessions converge Mini App, Bot chat history, content state, CloudStorage and uninstall', async () => {
  await withTwoDeviceServer(async (baseUrl) => {
    const mac = headers('mac-session-token', 'mac-a');
    const iphone = headers('iphone-session-token', 'iphone-b');
    const other = headers('other-session-token', 'other-c');

    const before = await json(await fetch(`${baseUrl}/v1/account/sync`, { headers: iphone }));
    assert.equal(before.mode, 'snapshot');
    assert.equal(before.snapshot.miniApps.length, 0);
    assert.equal(before.snapshot.bots.length, 0);

    const install = await json(await fetch(`${baseUrl}/v1/marketplace/plugins/global-dharma/add`, {
      method: 'POST',
      headers: mac,
      body: JSON.stringify({ platform: 'desktop' }),
    }));
    assert.equal(install.accountSynchronized, true);
    assert.equal(install.bot.id, 'global-dharma-bot');

    const iphoneApps = await json(await fetch(`${baseUrl}/v1/marketplace/added`, { headers: iphone }));
    assert.deepEqual(iphoneApps.apps.map((app) => app.id), ['global-dharma']);
    const iphoneBots = await json(await fetch(`${baseUrl}/v1/account/bots`, { headers: iphone }));
    assert.equal(iphoneBots.bots[0].bot.id, 'global-dharma-bot');
    assert.equal(iphoneBots.bots[0].sources[0].source, 'miniapp');

    const userMessage = {
      messageId: 'device-a-user-1',
      role: 'user',
      text: '/global-dharma:status',
      createdAt: '2026-08-27T00:00:01.000Z',
    };
    const assistantMessage = {
      messageId: 'device-a-bot-1',
      role: 'assistant',
      text: 'status: ready',
      createdAt: '2026-08-27T00:00:02.000Z',
    };
    await json(await fetch(`${baseUrl}/api/miniapps/global-dharma/messages`, {
      method: 'POST',
      headers: mac,
      body: JSON.stringify({ messages: [userMessage, assistantMessage] }),
    }));

    const historyOnIphone = await json(await fetch(`${baseUrl}/api/miniapps/global-dharma/messages?limit=100`, { headers: iphone }));
    assert.deepEqual(
      historyOnIphone.data.messages.map((message) => [message.messageId, message.role, message.text]),
      [
        ['device-a-user-1', 'user', '/global-dharma:status'],
        ['device-a-bot-1', 'assistant', 'status: ready'],
      ],
    );

    await json(await fetch(`${baseUrl}/v1/miniapps/global-dharma/cloud-storage`, {
      method: 'PUT',
      headers: mac,
      body: JSON.stringify({ values: { language: 'zh-CN', localMode: 'enabled' } }),
    }));
    const cloudOnIphone = await json(await fetch(`${baseUrl}/v1/miniapps/global-dharma/cloud-storage`, { headers: iphone }));
    assert.deepEqual(
      Object.fromEntries(cloudOnIphone.items.map((item) => [item.key, item.value])),
      { language: 'zh-CN', localMode: 'enabled' },
    );

    await json(await fetch(`${baseUrl}/api/miniapps/global-dharma/content-state`, {
      method: 'PUT',
      headers: mac,
      body: JSON.stringify({ state: { welcomeShown: true, welcomeShownAt: '2026-08-27T00:00:03.000Z' } }),
    }));
    const contentOnIphone = await json(await fetch(`${baseUrl}/api/miniapps/global-dharma/content-state`, { headers: iphone }));
    assert.equal(contentOnIphone.data.state.welcomeShown, true);

    const difference = await json(await fetch(`${baseUrl}/v1/account/sync?cursor=${encodeURIComponent(before.cursor)}&limit=100`, { headers: iphone }));
    assert.equal(difference.mode, 'difference');
    assert.deepEqual(
      difference.events.map((event) => event.type),
      [
        'miniapp.installed',
        'bot.added',
        'agent.created',
        'miniapp.bot.message',
        'miniapp.bot.message',
        'miniapp.cloud.set',
        'miniapp.cloud.set',
        'miniapp.content.updated',
      ],
    );

    const createdAgent = difference.events.find((event) => event.type === 'agent.created');
    const botAgentId = iphoneBots.bots[0].bot.agentId;
    assert.equal(typeof botAgentId, 'string');
    assert.equal(createdAgent.entityId, botAgentId);
    assert.equal(createdAgent.payload.agentId, botAgentId);
    assert.equal(createdAgent.payload.profile.agentId, botAgentId);
    assert.equal((await fetch(`${baseUrl}/v1/account/agents/${encodeURIComponent(botAgentId)}`, { headers: other })).status, 404);
    const otherApps = await json(await fetch(`${baseUrl}/v1/marketplace/added`, { headers: other }));
    assert.equal(otherApps.apps.length, 0);
    const otherHistory = await json(await fetch(`${baseUrl}/api/miniapps/global-dharma/messages?limit=100`, { headers: other }));
    assert.equal(otherHistory.data.messages.length, 0);
    const otherCloud = await json(await fetch(`${baseUrl}/v1/miniapps/global-dharma/cloud-storage`, { headers: other }));
    assert.equal(otherCloud.items.length, 0);

    const checkpoint = difference.cursor;
    await json(await fetch(`${baseUrl}/v1/marketplace/plugins/global-dharma/add`, { method: 'DELETE', headers: mac }));
    const removal = await json(await fetch(`${baseUrl}/v1/account/sync?cursor=${encodeURIComponent(checkpoint)}`, { headers: iphone }));
    assert.deepEqual(removal.events.map((event) => event.type), ['miniapp.removed', 'bot.removed']);
    const appsAfterRemove = await json(await fetch(`${baseUrl}/v1/marketplace/added`, { headers: iphone }));
    assert.equal(appsAfterRemove.apps.length, 0);
    const botsAfterRemove = await json(await fetch(`${baseUrl}/v1/account/bots`, { headers: iphone }));
    assert.equal(botsAfterRemove.bots.length, 0);

    const historySurvivesUninstall = await json(await fetch(`${baseUrl}/api/miniapps/global-dharma/messages?limit=100`, { headers: iphone }));
    assert.equal(historySurvivesUninstall.data.messages.length, 2);
    const cloudSurvivesUninstall = await json(await fetch(`${baseUrl}/v1/miniapps/global-dharma/cloud-storage`, { headers: iphone }));
    assert.equal(cloudSurvivesUninstall.items.length, 2);
  });
});
