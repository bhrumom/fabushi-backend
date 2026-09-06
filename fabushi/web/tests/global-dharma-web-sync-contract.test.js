import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';

const workspace = process.env.GITHUB_WORKSPACE
  ? resolve(process.env.GITHUB_WORKSPACE)
  : resolve(new URL('../../..', import.meta.url).pathname);
const appRoot = join(workspace, 'frontend/apps/web/src/app/miniapps/[id]');
const backendRoot = join(workspace, 'ai-backend/src');

const text = (path) => readFileSync(path, 'utf8');

test('WebMCP adapter keeps explicit approval and supplies idempotency identity to mutating tool calls', () => {
  const adapter = text(join(appRoot, 'WebMcpMiniAppAdapter.tsx'));
  assert.match(adapter, /tool\.annotations\?\.readOnlyHint !== true/);
  assert.match(adapter, /window\.confirm\(`允许 WebMCP 调用/);
  assert.match(adapter, /operationId:.*crypto\.randomUUID\(\)/s);
  assert.match(adapter, /client\.request\("tools\/call", \{ name, arguments: callArgs \}\)/);
});

test('Global Dharma Web UI replays account runtime by shared cursor rather than using MCP session state as business authority', () => {
  const app = text(join(appRoot, 'McpPluginApp.tsx'));
  assert.match(app, /\/v1\/miniapps\/\$\{encodeURIComponent\(normalizedId\)\}\/runtime/);
  assert.match(app, /runtimeEndpoint}\/difference\?cursor=/);
  assert.match(app, /payload\?\.mode === "snapshot"/);
  assert.match(app, /payload\?\.mode === "difference"/);
  assert.match(app, /runtimeCursorRef\.current/);
  assert.match(app, /data-testid="global-dharma-runtime"/);
});

test('AI backend never makes process memory the durable Global Dharma authority and keeps raw token out of runtime payload', () => {
  const official = text(join(backendRoot, 'official_mcp_apps.js'));
  const runtime = text(join(backendRoot, 'global_dharma_runtime_store.js'));
  const entitlement = text(join(backendRoot, 'global_dharma_entitlement.js'));
  assert.match(official, /runtimeStore\.runMutation/);
  assert.match(runtime, /AccountSyncStore/);
  assert.match(runtime, /miniapp\.runtime\.updated/);
  assert.match(runtime, /MINIAPP_IDEMPOTENCY_CONFLICT/);
  assert.doesNotMatch(runtime, /access[_-]?token|refresh[_-]?token|authorization/i);
  assert.match(entitlement, /Authorization: `Bearer \$\{credential\}`/);
  assert.doesNotMatch(entitlement, /return \{[^}]*credential/s);
});
