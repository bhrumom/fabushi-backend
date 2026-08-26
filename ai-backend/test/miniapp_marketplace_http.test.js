import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createMiniAppMarketplaceRouter } from '../src/miniapp_marketplace_http.js';

async function withServer(run, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-miniapp-http-'));
  const app = express();
  const { router } = createMiniAppMarketplaceRouter({
    storagePath: path.join(root, 'marketplace.json'),
    dataDir: root,
    resolveUser: options.resolveUser,
  });
  app.use(router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function json(response) {
  const payload = await response.json();
  assert.ok(response.ok, JSON.stringify(payload));
  return payload;
}

test('REST catalog supports search, release install metadata, add and command routing', async () => {
  await withServer(async (baseUrl) => {
    const headers = { 'x-fabushi-device-id': 'test-device-a', 'content-type': 'application/json' };
    const catalog = await json(await fetch(`${baseUrl}/v1/marketplace/plugins?q=global&platform=desktop`, { headers }));
    assert.equal(catalog.plugins[0].pluginId, 'global-dharma');

    const release = await json(await fetch(`${baseUrl}/v1/marketplace/plugins/global-dharma/releases/1.0.0?platform=desktop`, { headers }));
    assert.equal(release.releaseManifest.protocol, 'mahayana.external-release.v1');
    assert.equal(release.releaseManifest.artifacts.length, 1);
    assert.equal(release.bot.username, 'global_dharma_bot');

    const added = await json(await fetch(`${baseUrl}/v1/marketplace/plugins/global-dharma/add`, {
      method: 'POST', headers, body: JSON.stringify({ platform: 'desktop' }),
    }));
    assert.equal(added.added, true);
    assert.equal(added.accountSynchronized, false);
    assert.match(added.botEndpoint, /miniapp-bot\/global-dharma$/);

    const addedList = await json(await fetch(`${baseUrl}/v1/marketplace/added`, { headers }));
    assert.equal(addedList.apps[0].id, 'global-dharma');

    const routed = await json(await fetch(`${baseUrl}/v1/marketplace/plugins/global-dharma/route`, {
      method: 'POST', headers, body: JSON.stringify({ input: '/global-dharma:status' }),
    }));
    assert.equal(routed.command.name, 'status');
    assert.equal(routed.execution.kind, 'mcp-http');
  });
});

test('different device tokens for one account share Mini Apps, Bot membership, sync cursor and CloudStorage', async () => {
  const accounts = new Map([
    ['device-a-token', { userId: 'user:108', username: 'same-user', isAuthenticated: true }],
    ['device-b-token', { userId: 'user:108', username: 'same-user', isAuthenticated: true }],
    ['other-user-token', { userId: 'user:999', username: 'other-user', isAuthenticated: true }],
  ]);
  const resolveUser = async (req) => {
    const token = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const user = accounts.get(token);
    if (!user) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    return user;
  };

  await withServer(async (baseUrl) => {
    const deviceA = { authorization: 'Bearer device-a-token', 'x-fabushi-device-id': 'mac-a', 'content-type': 'application/json' };
    const deviceB = { authorization: 'Bearer device-b-token', 'x-fabushi-device-id': 'iphone-b', 'content-type': 'application/json' };
    const other = { authorization: 'Bearer other-user-token', 'x-fabushi-device-id': 'other-c', 'content-type': 'application/json' };

    const initial = await json(await fetch(`${baseUrl}/v1/account/sync`, { headers: deviceB }));
    assert.equal(initial.mode, 'snapshot');
    assert.equal(initial.snapshot.miniApps.length, 0);

    const added = await json(await fetch(`${baseUrl}/v1/marketplace/plugins/global-dharma/add`, {
      method: 'POST', headers: deviceA, body: JSON.stringify({ platform: 'desktop' }),
    }));
    assert.equal(added.accountSynchronized, true);
    assert.equal(added.bot.id, 'global-dharma-bot');

    const onB = await json(await fetch(`${baseUrl}/v1/marketplace/added`, { headers: deviceB }));
    assert.deepEqual(onB.apps.map((app) => app.id), ['global-dharma']);
    const botsOnB = await json(await fetch(`${baseUrl}/v1/account/bots`, { headers: deviceB }));
    assert.equal(botsOnB.bots[0].bot.id, 'global-dharma-bot');

    const difference = await json(await fetch(`${baseUrl}/v1/account/sync?cursor=${encodeURIComponent(initial.cursor)}`, { headers: deviceB }));
    assert.equal(difference.mode, 'difference');
    assert.deepEqual(difference.events.map((event) => event.type), ['miniapp.installed', 'bot.added']);

    await json(await fetch(`${baseUrl}/v1/miniapps/global-dharma/cloud-storage`, {
      method: 'PUT', headers: deviceA, body: JSON.stringify({ values: { language: 'zh-CN', mode: 'local' } }),
    }));
    const cloudOnB = await json(await fetch(`${baseUrl}/v1/miniapps/global-dharma/cloud-storage`, { headers: deviceB }));
    assert.deepEqual(Object.fromEntries(cloudOnB.items.map((item) => [item.key, item.value])), { language: 'zh-CN', mode: 'local' });

    const isolated = await json(await fetch(`${baseUrl}/v1/marketplace/added`, { headers: other }));
    assert.equal(isolated.apps.length, 0);
    const isolatedCloud = await json(await fetch(`${baseUrl}/v1/miniapps/global-dharma/cloud-storage`, { headers: other }));
    assert.equal(isolatedCloud.items.length, 0);

    await json(await fetch(`${baseUrl}/v1/marketplace/plugins/global-dharma/add`, { method: 'DELETE', headers: deviceA }));
    const removedOnB = await json(await fetch(`${baseUrl}/v1/marketplace/added`, { headers: deviceB }));
    assert.equal(removedOnB.apps.length, 0);
    const botsAfterRemove = await json(await fetch(`${baseUrl}/v1/account/bots`, { headers: deviceB }));
    assert.equal(botsAfterRemove.bots.length, 0);
    const cloudSurvivesUninstall = await json(await fetch(`${baseUrl}/v1/miniapps/global-dharma/cloud-storage`, { headers: deviceB }));
    assert.equal(cloudSurvivesUninstall.items.length, 2);
  }, { resolveUser });
});

test('manually added Bot membership synchronizes independently of Mini App installation', async () => {
  const resolveUser = async () => ({ userId: 'user:108', username: 'same-user', isAuthenticated: true });
  await withServer(async (baseUrl) => {
    const headers = { authorization: 'Bearer any-valid-session', 'content-type': 'application/json' };
    const added = await json(await fetch(`${baseUrl}/v1/account/bots/helper-bot/add`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bot: { username: 'helper_bot', displayName: 'Helper Bot', conversationId: 'bot:helper-bot' } }),
    }));
    assert.equal(added.bot.id, 'helper-bot');
    const bots = await json(await fetch(`${baseUrl}/v1/account/bots`, { headers }));
    assert.equal(bots.bots[0].bot.displayName, 'Helper Bot');
    await json(await fetch(`${baseUrl}/v1/account/bots/helper-bot/add`, { method: 'DELETE', headers }));
    const empty = await json(await fetch(`${baseUrl}/v1/account/bots`, { headers }));
    assert.equal(empty.bots.length, 0);
  }, { resolveUser });
});

test('BotFather creates a Mahayana workflow and review gates global discovery', async () => {
  await withServer(async (baseUrl) => {
    const deviceHeaders = { 'x-fabushi-device-id': 'publisher-device', 'content-type': 'application/json' };
    const workflow = await json(await fetch(`${baseUrl}/v1/marketplace/botfather/generate`, {
      method: 'POST',
      headers: deviceHeaders,
      body: JSON.stringify({
        prompt: 'Build a searchable Mini App with web UI and MCP status command.',
        id: 'review-demo',
        title: 'Review Demo',
        description: 'Demonstrates source-backed publication review.',
        surfaces: ['web', 'mcp-http'],
        repository: 'https://github.com/example/review-demo',
      }),
    }));
    assert.equal(workflow.workflow.protocol, 'mahayana.miniapp.generation.v1');

    const draft = await json(await fetch(`${baseUrl}/v1/marketplace/publisher/drafts`, {
      method: 'POST',
      headers: deviceHeaders,
      body: JSON.stringify({
        id: 'review-demo',
        version: '1.0.0',
        title: 'Review Demo',
        description: 'Demonstrates source-backed publication review.',
        surfaces: [
          { id: 'web', kind: 'web', url: 'https://example.com/review-demo/' },
          { id: 'mcp', kind: 'mcp-http', url: 'https://example.com/review-demo/mcp' },
        ],
        commands: [{ name: 'status', description: 'Read status', surfaceId: 'mcp', tool: 'status' }],
        distribution: {
          installMode: 'metadata',
          repository: 'https://github.com/example/review-demo',
          sourceRef: 'v1.0.0',
        },
      }),
    }));
    assert.equal(draft.miniApp.review.state, 'draft');

    const submitted = await json(await fetch(`${baseUrl}/v1/marketplace/publisher/review-demo/submit`, {
      method: 'POST', headers: deviceHeaders, body: '{}',
    }));
    assert.equal(submitted.miniApp.review.state, 'pending_review');

    const hidden = await json(await fetch(`${baseUrl}/v1/marketplace/plugins?q=Review%20Demo`, { headers: deviceHeaders }));
    assert.equal(hidden.plugins.length, 0);

    const previousToken = process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN;
    process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN = 'review-token-0123456789-0123456789';
    try {
      const approved = await json(await fetch(`${baseUrl}/v1/marketplace/review/review-demo`, {
        method: 'POST',
        headers: {
          ...deviceHeaders,
          'x-fabushi-marketplace-review-token': process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN,
        },
        body: JSON.stringify({ approved: true, reviewer: 'test-reviewer' }),
      }));
      assert.equal(approved.miniApp.review.state, 'approved');
    } finally {
      if (previousToken === undefined) delete process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN;
      else process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN = previousToken;
    }

    const visible = await json(await fetch(`${baseUrl}/v1/marketplace/plugins?q=Review%20Demo`, { headers: deviceHeaders }));
    assert.equal(visible.plugins[0].pluginId, 'review-demo');
  });
});
