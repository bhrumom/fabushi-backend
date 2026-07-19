const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const pluginMcpTokenEnv = 'FABUSHI_PLUGIN_MCP_TOKEN';

export function pluginConversationNamespace(pluginId) {
  const id = String(pluginId || '').trim();
  if (!PLUGIN_ID.test(id)) throw new Error('invalid plugin id');
  return `mcp:${id}`;
}

export function createPluginCodexPolicy(pluginId, mcpOrigin) {
  const namespace = pluginConversationNamespace(pluginId);
  const origin = String(mcpOrigin || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(origin)) throw new Error('invalid MCP origin');
  return {
    namespace,
    sandboxMode: 'read-only',
    approvalPolicy: 'on-request',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    config: {
      features: { shell_tool: false, web_search_request: false },
      tools: { web_search: false, view_image: false },
      mcp_servers: {
        current_plugin: {
          url: `${origin}/api/mcp/apps/${encodeURIComponent(pluginId)}`,
          bearer_token_env_var: pluginMcpTokenEnv,
          startup_timeout_sec: 15,
          tool_timeout_sec: 120,
        },
      },
    },
  };
}
