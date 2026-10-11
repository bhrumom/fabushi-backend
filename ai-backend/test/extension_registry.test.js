import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  browseExtensions,
  ExtensionRegistryError,
  normalizeExtensionEntry,
  readExtension,
} from '../src/extension_registry.js';
import { createMiniAppMarketplaceRouter } from '../src/miniapp_marketplace_http.js';

function approvedMiniApp() {
  return {
    id: 'notes-offline',
    version: '1.2.3',
    title: 'Offline Notes',
    description: 'A local notes mini app.',
    publisher: { id: 'acme-labs', displayName: 'Acme Labs', verified: true },
    categories: ['Productivity'],
    tags: ['notes', 'offline'],
    permissions: ['storage.local'],
    digest: 'a'.repeat(64),
    protocol: 'fabushi.miniapp.manifest.v2',
    review: { state: 'approved' },
    distribution: { installMode: 'package' },
    surfaces: [
      { id: 'web', kind: 'web', platforms: ['desktop', 'mobile'] },
    ],
  };
}

function fakeMarketplace() {
  return { list: () => [approvedMiniApp()] };
}

test('strict unified entry rejects unknown kind and secret-shaped public fields', () => {
  assert.throws(
    () => normalizeExtensionEntry({
      identity: { namespace: 'fabushi', name: 'bad', kind: 'native-plugin' },
      origin: 'public',
      trustDomain: 'catalog-authorized',
      release: { version: '1.0.0', platforms: ['desktop'] },
    }),
    (error) => error instanceof ExtensionRegistryError && error.code === 'INVALID_EXTENSION_FILTER',
  );

  assert.throws(
    () => normalizeExtensionEntry({
      identity: { namespace: 'fabushi', name: 'bad-secret', kind: 'skill' },
      origin: 'public',
      trustDomain: 'catalog-authorized',
      release: { version: '1.0.0', platforms: ['desktop'] },
      runtime: { accessToken: 'must-never-be-public' },
    }),
    (error) => error instanceof ExtensionRegistryError && error.code === 'REGISTRY_SECRET_FIELD',
  );
});

test('registry projects existing Mini Apps and official MCP apps without fabricating Skills', () => {
  const marketplace = fakeMarketplace();
  const all = browseExtensions(marketplace, { limit: 100 });
  assert.equal(all.protocol, 'fabushi.extension-registry.v1');

  const mini = all.entries.find((entry) => entry.identity.kind === 'web-miniapp');
  assert.ok(mini);
  assert.equal(mini.id, 'acme-labs/notes-offline:web-miniapp');
  assert.deepEqual(mini.release.platforms.includes('ios'), true);
  assert.deepEqual(mini.release.platforms.includes('android'), true);
  assert.equal(mini.publisher.verified, false);
  assert.deepEqual(mini.publisher.verificationEvidence, []);
  assert.equal(mini.legacy.pluginId, 'notes-offline');

  const mcp = all.entries.find((entry) => entry.identity.kind === 'mcp-connector');
  assert.ok(mcp);
  assert.equal(mcp.runtime.owner, 'official-mcp-apps');
  assert.equal(mcp.runtime.transport, 'streamable-http');
  assert.equal(mcp.publisher.verified, false);

  const skills = browseExtensions(marketplace, { kind: 'skill' });
  assert.deepEqual(skills.entries, []);
});

test('registry filters by kind, origin and platform and uses deterministic cursor pagination', () => {
  const marketplace = fakeMarketplace();
  const ios = browseExtensions(marketplace, { platform: 'ios', limit: 100 });
  assert.ok(ios.entries.some((entry) => entry.id === 'acme-labs/notes-offline:web-miniapp'));

  const first = browseExtensions(marketplace, { limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.ok(first.nextCursor);

  const second = browseExtensions(marketplace, { limit: 100, cursor: first.nextCursor });
  assert.ok(second.entries.length >= 1);
  assert.notEqual(second.entries[0].id, first.entries[0].id);

  assert.throws(
    () => browseExtensions(marketplace, { cursor: Buffer.from(JSON.stringify({ v: 1, after: 'missing/x:skill' })).toString('base64url') }),
    (error) => error instanceof ExtensionRegistryError && error.code === 'STALE_EXTENSION_CURSOR',
  );

  assert.throws(
    () => browseExtensions(marketplace, { platform: 'plan9' }),
    (error) => error instanceof ExtensionRegistryError && error.code === 'INVALID_EXTENSION_FILTER',
  );
});

test('detail lookup resolves stable identity and fails closed for unknown entries', () => {
  const marketplace = fakeMarketplace();
  const entry = readExtension(marketplace, {
    kind: 'web-miniapp',
    namespace: 'acme-labs',
    name: 'notes-offline',
  });
  assert.equal(entry.release.version, '1.2.3');

  assert.throws(
    () => readExtension(marketplace, { kind: 'skill', namespace: 'acme-labs', name: 'missing' }),
    (error) => error instanceof ExtensionRegistryError && error.code === 'EXTENSION_NOT_FOUND',
  );
});

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-extension-registry-'));
  const app = express();
  const { router } = createMiniAppMarketplaceRouter({
    storagePath: path.join(root, 'marketplace.json'),
    dataDir: root,
  });
  app.use(router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('HTTP registry exposes typed browse and detail without private account state', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/extensions?kind=mcp-connector&platform=desktop&limit=2`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.protocol, 'fabushi.extension-registry.v1');
    assert.equal(payload.entries.length, 2);
    assert.ok(payload.entries.every((entry) => entry.identity.kind === 'mcp-connector'));
    assert.doesNotMatch(JSON.stringify(payload), /accessToken|refreshToken|clientSecret|authorization/i);

    const selected = payload.entries[0];
    const detail = await fetch(
      `${baseUrl}/v1/extensions/${encodeURIComponent(selected.identity.kind)}/${encodeURIComponent(selected.identity.namespace)}/${encodeURIComponent(selected.identity.name)}`,
    );
    assert.equal(detail.status, 200);
    const detailPayload = await detail.json();
    assert.equal(detailPayload.extension.id, selected.id);

    const invalid = await fetch(`${baseUrl}/v1/extensions?kind=native-plugin`);
    assert.equal(invalid.status, 400);
    const invalidPayload = await invalid.json();
    assert.equal(invalidPayload.error.code, 'INVALID_EXTENSION_FILTER');
  });
});
