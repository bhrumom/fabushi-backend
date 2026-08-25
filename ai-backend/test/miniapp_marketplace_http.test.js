import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createMiniAppMarketplaceRouter } from '../src/miniapp_marketplace_http.js';

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-miniapp-http-'));
  const app = express();
  const { router } = createMiniAppMarketplaceRouter({ storagePath: path.join(root, 'marketplace.json') });
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
