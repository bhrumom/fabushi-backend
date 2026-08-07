import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeReleaseManifest,
  validateTrustedReleaseWorkflow,
  validateUntrustedPullRequestWorkflow,
} from '../src/marketplace/github-native-contract.js';

const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

function artifact(overrides = {}) {
  return {
    id: 'common',
    kind: 'common',
    sourceCommit: SHA1,
    url: 'https://github.com/example/app/releases/download/v1/common.tar.gz',
    sha256: SHA256,
    size: 1024,
    mediaType: 'application/gzip',
    sbomUrl: 'https://github.com/example/app/releases/download/v1/common.spdx.json',
    attestationUrl: 'https://github.com/example/app/attestations/1',
    minHostVersion: '1.0.0',
    requiredCapabilities: [],
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    pluginId: 'io.mahayana.example.app',
    version: '1.0.0',
    source: {
      provider: 'github',
      repositoryId: 123456,
      repository: 'example/app',
      defaultBranch: 'main',
      commit: SHA1,
      treeHash: 'c'.repeat(40),
      licenseSpdx: 'Apache-2.0',
      visibility: 'public',
      subdirectory: '.',
    },
    toolContract: {
      schemaVersion: 1,
      sha256: SHA256,
      tools: ['status', 'send'],
      errorCodes: ['invalid_input'],
    },
    mcpApps: {
      specification: '2026-01-26',
      extension: 'io.modelcontextprotocol/ui',
      mimeType: 'text/html;profile=mcp-app',
      resources: ['ui://io.mahayana.example.app/main'],
      displayModes: ['inline', 'fullscreen'],
      cspSha256: SHA256,
    },
    permissionsSha256: SHA256,
    parentManifestSha256: SHA256,
    artifacts: [
      artifact(),
      artifact({
        id: 'native-linux-x64',
        kind: 'native-cli',
        os: 'linux',
        architecture: 'x64',
        url: 'https://github.com/example/app/releases/download/v1/native-linux-x64.tar.gz',
      }),
      artifact({
        id: 'web-wasm',
        kind: 'web-wasm',
        webTargets: ['ios', 'android', 'web', 'pwa'],
        wasmFeatures: ['simd'],
        url: 'https://github.com/example/app/releases/download/v1/web-wasm.tar.gz',
      }),
    ],
    ...overrides,
  };
}

test('normalizes a single-identity multi-artifact MCP App release', () => {
  const normalized = normalizeReleaseManifest(manifest());
  assert.equal(normalized.protocol, 'mahayana.mcp-app-release.v3');
  assert.equal(normalized.source.repositoryId, 123456);
  assert.deepEqual(normalized.artifacts.map((item) => item.id), [
    'common',
    'native-linux-x64',
    'web-wasm',
  ]);
  assert.ok(normalized.artifacts.every((item) => item.sourceCommit === SHA1));
});

test('rejects an artifact built from a different source commit', () => {
  const value = manifest();
  value.artifacts[2].sourceCommit = 'd'.repeat(40);
  assert.throws(() => normalizeReleaseManifest(value), (error) => {
    assert.equal(error.code, 'source_commit_mismatch');
    return true;
  });
});

test('rejects public source without an explicit SPDX license', () => {
  const value = manifest();
  value.source.licenseSpdx = 'NOASSERTION';
  assert.throws(() => normalizeReleaseManifest(value), (error) => {
    assert.equal(error.code, 'license_required');
    return true;
  });
});

test('derived release must use a new plugin ID and fork repository', () => {
  const value = manifest({
    derivation: {
      upstreamPluginId: 'io.mahayana.example.app',
      upstreamRepository: 'upstream/app',
      upstreamCommit: SHA1,
      syncBaseCommit: SHA1,
      permissionDiffSha256: SHA256,
      toolContractDiffSha256: SHA256,
      artifactDiffSha256: SHA256,
      trademarkNotice: 'Unofficial derivative; not endorsed by upstream.',
    },
  });
  assert.throws(() => normalizeReleaseManifest(value), (error) => {
    assert.equal(error.code, 'derived_plugin_id_reuse');
    return true;
  });

  value.pluginId = 'io.mahayana.fork.app';
  const normalized = normalizeReleaseManifest(value);
  assert.equal(normalized.derivation.upstreamPluginId, 'io.mahayana.example.app');
});

test('untrusted fork CI forbids secrets, write permission and publishing', () => {
  const safe = `name: Fork CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
  assert.deepEqual(validateUntrustedPullRequestWorkflow(safe), { valid: true, failures: [] });

  const unsafe = `${safe}\n      - run: wrangler deploy --api-token \${{ secrets.CLOUDFLARE_API_TOKEN }}\npermissions:\n  contents: write\n  id-token: write\n`;
  const result = validateUntrustedPullRequestWorkflow(unsafe);
  assert.equal(result.valid, false);
  assert.ok(result.failures.some((failure) => failure.includes('secrets')));
  assert.ok(result.failures.some((failure) => failure.includes('publish')));
});

test('trusted release requires OIDC, attestations and exact source commit', () => {
  const workflow = `name: Trusted release
on:
  release:
    types: [published]
permissions:
  contents: read
  id-token: write
  attestations: write
env:
  SOURCE_COMMIT: \${{ github.sha }}
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/attest-build-provenance@v2
`;
  assert.deepEqual(validateTrustedReleaseWorkflow(workflow), { valid: true, failures: [] });
  assert.equal(validateTrustedReleaseWorkflow(workflow.replace('id-token: write', 'id-token: read')).valid, false);
});
