import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPluginCodexPolicy,
  pluginConversationNamespace,
  pluginMcpTokenEnv,
} from '../src/plugin_codex_policy.js';

test('plugin Codex policy exposes only the selected MCP server', () => {
  const policy = createPluginCodexPolicy('global-dharma', 'http://127.0.0.1:8788/');
  assert.equal(policy.namespace, 'mcp:global-dharma');
  assert.equal(policy.sandboxMode, 'read-only');
  assert.equal(policy.approvalPolicy, 'on-request');
  assert.equal(policy.networkAccessEnabled, false);
  assert.equal(policy.webSearchMode, 'disabled');
  assert.deepEqual(Object.keys(policy.config.mcp_servers), ['current_plugin']);
  assert.equal(
    policy.config.mcp_servers.current_plugin.url,
    'http://127.0.0.1:8788/api/mcp/apps/global-dharma',
  );
  assert.equal(
    policy.config.mcp_servers.current_plugin.bearer_token_env_var,
    pluginMcpTokenEnv,
  );
  assert.equal(policy.config.features.shell_tool, false);
  assert.equal(policy.config.tools.web_search, false);
  assert.equal(policy.config.tools.view_image, false);
});

test('plugin conversation namespaces reject unsafe plugin ids', () => {
  assert.equal(pluginConversationNamespace('bot-father'), 'mcp:bot-father');
  assert.throws(() => pluginConversationNamespace('../other-plugin'), /invalid plugin id/);
});
