import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

import { registerPlatformApi } from '../src/platform_api.js';

async function withServer(run) {
  const db = new Database(':memory:');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerPlatformApi({
    app,
    db,
    resolveUser: async (req) => ({ userId: req.headers['x-test-user'] || 'user-a' }),
    asyncHandler: (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next),
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
}

test('merges mini-app messages and content receipts by stable instance id', async () => {
  await withServer(async (base) => {
    const instance = 'reader@0123456789abcdef0123456789abcdef';
    const endpoint = `${base}/api/miniapps/${encodeURIComponent(instance)}`;
    const headers = { 'content-type': 'application/json', 'x-test-user': 'user-a' };
    const firstMessage = {
      messageId: 'welcome:welcome', role: 'miniapp', text: '欢迎',
      payload: { homeKey: 'welcome:welcome' }, createdAt: '2026-01-01T00:00:00.000Z',
    };
    let response = await fetch(`${endpoint}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ messages: [firstMessage] }),
    });
    assert.equal(response.status, 200);
    response = await fetch(`${endpoint}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ message: { ...firstMessage, text: '欢迎回来', updatedAt: '2026-01-02T00:00:00.000Z' } }),
    });
    assert.equal(response.status, 200);

    response = await fetch(`${endpoint}/content-state`, {
      method: 'PUT', headers, body: JSON.stringify({ state: {
        welcomeShown: true,
        welcomeShownAt: '2026-01-01T00:00:00.000Z',
        receipts: [{ itemId: 'notice', revision: '1', readAt: '2026-01-01T00:00:00.000Z' }],
      } }),
    });
    assert.equal(response.status, 200);
    response = await fetch(`${endpoint}/content-state`, {
      method: 'PUT', headers, body: JSON.stringify({ state: {
        receipts: [
          { itemId: 'notice', revision: '1', readAt: '2026-01-03T00:00:00.000Z' },
          { itemId: 'notice', revision: '2', readAt: '2026-01-04T00:00:00.000Z' },
        ],
      } }),
    });
    const merged = (await response.json()).data.state;
    assert.deepEqual(merged, {
      welcomeShown: true,
      welcomeShownAt: '2026-01-01T00:00:00.000Z',
      receipts: [
        { itemId: 'notice', revision: '1', readAt: '2026-01-03T00:00:00.000Z' },
        { itemId: 'notice', revision: '2', readAt: '2026-01-04T00:00:00.000Z' },
      ],
    });

    const messages = await fetch(`${endpoint}/messages`, { headers }).then((value) => value.json());
    assert.equal(messages.data.messages.length, 1);
    assert.equal(messages.data.messages[0].text, '欢迎回来');

    const isolated = await fetch(`${endpoint}/messages`, {
      headers: { ...headers, 'x-test-user': 'user-b' },
    }).then((value) => value.json());
    assert.deepEqual(isolated.data.messages, []);
  });
});

test('reset onboarding is explicit and repair previews redact secrets', async () => {
  await withServer(async (base) => {
    const instance = 'reader@0123456789abcdef0123456789abcdef';
    const endpoint = `${base}/api/miniapps/${encodeURIComponent(instance)}`;
    const headers = { 'content-type': 'application/json' };
    await fetch(`${endpoint}/content-state`, {
      method: 'PUT', headers, body: JSON.stringify({ state: { welcomeShown: true } }),
    });
    const reset = await fetch(`${endpoint}/content-state`, {
      method: 'PUT', headers, body: JSON.stringify({ resetOnboarding: true }),
    }).then((value) => value.json());
    assert.deepEqual(reset.data.state, { welcomeShown: false, welcomeShownAt: null, receipts: [] });

    const repair = await fetch(`${endpoint}/repair`, {
      method: 'POST', headers, body: JSON.stringify({
        pluginId: 'reader', source: 'https://github.com/example/reader',
        error: 'token=super-secret', logs: 'Authorization: Bearer abc.def',
      }),
    }).then((value) => value.json());
    assert.equal(repair.data.requiresConfirmation, true);
    assert.doesNotMatch(JSON.stringify(repair.data.preview), /super-secret|abc\.def/);
  });
});
