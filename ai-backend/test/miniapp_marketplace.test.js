import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MiniAppMarketplace,
  MiniAppMarketplaceError,
  normalizeMiniAppManifest,
} from '../src/miniapp_marketplace.js';
import {
  MINIAPP_PACKAGE_COMMIT,
  marketplaceReleaseResponse,
  officialMiniAppPackageSeeds,
} from '../src/miniapp_marketplace_catalog.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-miniapp-marketplace-'));
  const storagePath = path.join(root, 'marketplace.json');
  const marketplace = new MiniAppMarketplace({
    storagePath,
    seed: officialMiniAppPackageSeeds(),
    now: () => 1_900_000_000_000,
  });
  return {
    root,
    storagePath,
    marketplace,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function thirdPartyManifest() {
  return {
    id: 'example-tool',
    version: '1.2.3',
    title: 'Example Tool',
    description: 'A source-backed Mini App with a web UI and remote MCP tools.',
    publisher: { id: 'example-publisher', displayName: 'Example Publisher' },
    categories: ['utilities'],
    tags: ['example', 'mcp'],
    bot: { username: 'example_tool_bot' },
    surfaces: [
      {
        id: 'web-ui',
        kind: 'web',
        url: 'https://example.com/miniapp/',
        platforms: ['desktop', 'mobile', 'web'],
      },
      {
        id: 'remote-mcp',
        kind: 'mcp-http',
        url: 'https://example.com/mcp',
        platforms: ['desktop', 'mobile', 'web', 'cli'],
      },
    ],
    commands: [
      {
        name: 'status',
        aliases: ['state'],
        description: 'Read current status',
        naturalLanguageHints: ['show current status'],
        surfaceId: 'remote-mcp',
        tool: 'status',
      },
    ],
    distribution: {
      installMode: 'metadata',
      repository: 'https://github.com/example/example-tool',
      manifestUrl: 'https://raw.githubusercontent.com/example/example-tool/v1.2.3/fabushi-miniapp.json',
      sourceRef: 'v1.2.3',
    },
    permissions: ['network'],
  };
}

test('official catalog is searchable and uses immutable external artifacts', () => {
  const scope = fixture();
  try {
    const result = scope.marketplace.browse({ query: 'global mcp cli', platform: 'desktop' });
    assert.equal(result.protocol, 'fabushi.miniapp.marketplace.v2');
    assert.equal(result.plugins[0].pluginId, 'global-dharma');
    assert.equal(result.plugins[0].source.installMode, 'package');

    const manifest = scope.marketplace.get('global-dharma');
    assert.equal(manifest.distribution.sourceRef, MINIAPP_PACKAGE_COMMIT);
    assert.equal(manifest.distribution.marketplaceHostsPackage, false);
    assert.match(manifest.distribution.artifacts[0].url, new RegExp(MINIAPP_PACKAGE_COMMIT));
    assert.equal(manifest.distribution.artifacts[0].sha256.length, 64);

    const release = marketplaceReleaseResponse(manifest, 'desktop');
    assert.equal(release.releaseManifest.schemaVersion, 1);
    assert.equal(release.releaseManifest.protocol, 'mahayana.external-release.v1');
    assert.equal(release.releaseManifest.artifacts[0].runtime, 'local-web');
    assert.equal(release.releaseManifest.artifacts[0].format, 'tar-gz');
    assert.equal(release.source.marketplaceHostsPackage, false);
  } finally {
    scope.cleanup();
  }
});

test('Douyin downloader is searchable in Chinese and installable from an immutable package', () => {
  const scope = fixture();
  try {
    for (const query of ['抖音', '无水印', '视频下载']) {
      const result = scope.marketplace.browse({ query, platform: 'desktop' });
      assert.equal(result.plugins[0].pluginId, 'douyin-batch-downloader');
    }
    const manifest = scope.marketplace.get('douyin-batch-downloader');
    assert.equal(manifest.distribution.installMode, 'package');
    assert.equal(manifest.review.state, 'approved');
    assert.equal(manifest.distribution.artifacts[0].sha256.length, 64);
    const added = scope.marketplace.add('douyin-batch-downloader', 'douyin-test');
    assert.equal(added.added, true);
    assert.equal(scope.marketplace.added('douyin-test')[0].id, 'douyin-batch-downloader');
  } finally {
    scope.cleanup();
  }
});

test('add state persists per scope and returns a default Mini App bot', () => {
  const scope = fixture();
  try {
    const added = scope.marketplace.add('global-dharma', 'scope-a');
    assert.equal(added.added, true);
    assert.equal(added.bot.id, 'global-dharma-bot');
    assert.equal(added.bot.menuButton.action, 'open-miniapp');
    assert.equal(scope.marketplace.added('scope-a').length, 1);
    assert.equal(scope.marketplace.added('scope-b').length, 0);

    const reloaded = new MiniAppMarketplace({
      storagePath: scope.storagePath,
      seed: officialMiniAppPackageSeeds(),
    });
    assert.equal(reloaded.added('scope-a')[0].id, 'global-dharma');
  } finally {
    scope.cleanup();
  }
});

test('slash input and natural language resolve to the same declared command', () => {
  const scope = fixture();
  try {
    const slash = scope.marketplace.routeInput('global-dharma', '/global-dharma:status {"detail":true}');
    assert.equal(slash.kind, 'command');
    assert.equal(slash.command.tool, 'status');
    assert.deepEqual(slash.arguments, { detail: true });

    const natural = scope.marketplace.routeInput('global-dharma', 'please show status now');
    assert.equal(natural.kind, 'natural-language');
    assert.equal(natural.suggestedCommand.name, 'status');
    assert.equal(natural.requiresMahayanaPlanning, true);

    assert.throws(
      () => scope.marketplace.routeInput('global-dharma', '/other-app:status'),
      (error) => error instanceof MiniAppMarketplaceError && error.code === 'COMMAND_MISMATCH',
    );
  } finally {
    scope.cleanup();
  }
});

test('publisher draft remains private until review approval', () => {
  const scope = fixture();
  try {
    const draft = scope.marketplace.createDraft(thirdPartyManifest());
    assert.equal(draft.review.state, 'draft');
    assert.equal(scope.marketplace.browse({ query: 'Example Tool' }).plugins.length, 0);

    const pending = scope.marketplace.submit(draft.id, 'example-publisher');
    assert.equal(pending.review.state, 'pending_review');
    assert.equal(scope.marketplace.browse({ query: 'Example Tool' }).plugins.length, 0);

    const approved = scope.marketplace.review(draft.id, {
      approved: true,
      reviewer: 'marketplace-reviewer',
      notes: 'source and permissions verified',
    });
    assert.equal(approved.review.state, 'approved');
    assert.equal(scope.marketplace.browse({ query: 'Example Tool' }).plugins[0].pluginId, draft.id);
  } finally {
    scope.cleanup();
  }
});

test('BotFather generation workflow is a Mahayana dependency graph', () => {
  const scope = fixture();
  try {
    const workflow = scope.marketplace.generationWorkflow({
      prompt: 'Build a cross-platform Mini App with GUI, MCP and CLI control.',
      publisher: { id: 'example-publisher', displayName: 'Example Publisher' },
      id: 'generated-app',
      title: 'Generated App',
      description: 'Generated by the Mahayana multi-step agent.',
      surfaces: ['web', 'mcp-http', 'cli'],
      repository: 'https://github.com/example/generated-app',
    });
    assert.equal(workflow.protocol, 'mahayana.miniapp.generation.v1');
    assert.equal(workflow.mode, 'mahayana-agent');
    assert.equal(workflow.steps[0].state, 'ready');
    assert.ok(workflow.steps.some((step) => step.id === 'submit-review'));
    assert.ok(workflow.acceptance.some((item) => item.includes('marketplace stores metadata')));
  } finally {
    scope.cleanup();
  }
});

test('local execution cannot masquerade as a metadata-only web install', () => {
  assert.throws(
    () => normalizeMiniAppManifest({
      ...thirdPartyManifest(),
      id: 'unsafe-local-only',
      surfaces: [{ id: 'cli', kind: 'cli', command: 'unsafe-local-only run', local: true }],
      distribution: {
        installMode: 'metadata',
        repository: 'https://github.com/example/unsafe-local-only',
      },
    }),
    (error) => error instanceof MiniAppMarketplaceError && error.code === 'INVALID_MANIFEST',
  );
});
