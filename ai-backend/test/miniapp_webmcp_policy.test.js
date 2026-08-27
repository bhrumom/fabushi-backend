import assert from 'node:assert/strict';
import test from 'node:test';

import { MiniAppMarketplace, officialMiniAppManifests } from '../src/miniapp_marketplace.js';
import {
  FABUSHI_WEBMCP_CONTRACT,
  assertMiniAppWebMcpReady,
  installWebMcpMarketplacePolicy,
} from '../src/miniapp_webmcp_policy.js';

test('every official MiniApp has a WebMCP-ready Tool contract', () => {
  for (const manifest of officialMiniAppManifests()) {
    const contract = assertMiniAppWebMcpReady(manifest);
    assert.equal(contract.protocol, FABUSHI_WEBMCP_CONTRACT);
    assert.equal(contract.required, true);
    assert.ok(contract.tools.length > 0, `${manifest.id} has no WebMCP tools`);
  }
});

test('marketplace policy rejects drafts without a Tool contract', () => {
  class PolicyMarketplace extends MiniAppMarketplace {}
  installWebMcpMarketplacePolicy(PolicyMarketplace);
  const marketplace = Object.create(PolicyMarketplace.prototype);
  marketplace.get = () => null;
  const original = PolicyMarketplace.prototype.createDraft;
  assert.throws(() => original.call({
    now: () => Date.now(),
    document: { apps: [], sequence: 0 },
    seed: [],
    storagePath: '/tmp/unused-webmcp-policy.json',
  }, {}));
});

test('WebMCP policy rejects manifests with no tools', () => {
  assert.throws(
    () => assertMiniAppWebMcpReady({ id: 'empty-miniapp', commands: [] }),
    /must expose at least one Tool/,
  );
});
