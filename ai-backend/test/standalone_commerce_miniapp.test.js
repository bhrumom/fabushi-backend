import assert from 'node:assert/strict';
import test from 'node:test';

import { MiniAppMarketplace } from '../src/miniapp_marketplace.js';
import { marketplaceReleaseResponse, officialMiniAppPackageSeeds } from '../src/miniapp_marketplace_catalog.js';
import {
  STANDALONE_COMMERCE_MCP_URL,
  STANDALONE_COMMERCE_SITE_URL,
  standaloneCommerceMiniAppManifest,
} from '../src/standalone_commerce_miniapp.js';

test('standalone commerce site is a metadata Mini App with independent web and AI surfaces', () => {
  const manifest = standaloneCommerceMiniAppManifest();

  assert.equal(manifest.id, 'fabushi-store');
  assert.equal(manifest.homepage, `${STANDALONE_COMMERCE_SITE_URL}/`);
  assert.equal(manifest.distribution.installMode, 'metadata');
  assert.equal(manifest.distribution.marketplaceHostsPackage, false);
  assert.equal(manifest.review.state, 'approved');
  assert.ok(manifest.permissions.includes('commerce.purchase'));

  const web = manifest.surfaces.find((surface) => surface.id === 'storefront');
  const mcp = manifest.surfaces.find((surface) => surface.id === 'commerce-mcp');
  assert.equal(web?.kind, 'web');
  assert.equal(web?.url, `${STANDALONE_COMMERCE_SITE_URL}/`);
  assert.equal(mcp?.kind, 'mcp-http');
  assert.equal(mcp?.url, STANDALONE_COMMERCE_MCP_URL);

  const placeOrder = manifest.commands.find((command) => command.name === 'place_order');
  assert.equal(placeOrder?.tool, 'place_order');
  assert.equal(placeOrder?.approval, 'destructive');
});

test('standalone commerce manifest can be discovered beside existing official Mini Apps', () => {
  const commerce = standaloneCommerceMiniAppManifest();
  const marketplace = new MiniAppMarketplace({
    storagePath: null,
    seed: [...officialMiniAppPackageSeeds(), commerce],
  });

  const result = marketplace.browse({ query: '跨境电商', limit: 50 });
  assert.ok(result.plugins.some((plugin) => plugin.pluginId === 'fabushi-store'));

  const release = marketplaceReleaseResponse(marketplace.get('fabushi-store'));
  assert.equal(release.installMode, 'metadata');
  assert.equal(release.bot.username, 'fabushi_store_bot');
  assert.equal(release.releaseManifest.artifacts.length, 0);
});
