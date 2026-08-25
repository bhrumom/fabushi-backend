import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const officialMcpApps = readFileSync(
  new URL('../src/official_mcp_apps.js', import.meta.url),
  'utf8',
);

test('official Global Dharma MCP requests the exact monetized host capability', () => {
  assert.match(
    officialMcpApps,
    /capability:\s*['"]local\.prayer-wheel\.start['"]/,
  );
});
