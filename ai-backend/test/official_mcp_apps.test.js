import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import express from 'express';

import {
  createOfficialMcpServer,
  handleOfficialMcpRequest,
  officialMcpApps,
} from '../src/official_mcp_apps.js';

const expectedTools = {
  'global-dharma': ['home', 'chat', 'start', 'stop', 'loop', 'status', 'send', 'logs', 'validate_config', 'deploy_latest'],
  'faliu-flashcards': ['home', 'create_deck', 'list_decks', 'open_deck', 'review_next', 'submit_review'],
  'platform-publish': ['home', 'create_draft', 'save_draft', 'open_draft', 'publish', 'status'],
  'hermes-installer': ['home', 'install', 'start', 'status', 'chat', 'stop', 'reset'],
  'bot-father': ['home', 'create_plugin', 'validate_plugin', 'build_plugin', 'install_plugin', 'publish_plugin', 'deployment_status'],
  'mahayana-assistant': ['home', 'help', 'list_plugins', 'plugin_status', 'diagnose_plugin'],
  'chatgpt-auto-confirm': [
    'home', 'start', 'stop', 'status', 'scan_once', 'relaunch_and_confirm',
    'audit_log', 'diagnose', 'send_and_watch', 'add_connector', 'get_reply',
    'chat_status', 'prompt_templates', 'enqueue_tasks', 'start_queue',
    'queue_status', 'wait_for_review', 'review_task', 'pause_queue',
    'resume_queue', 'retry_task', 'cancel_task',
  ],
};

async function connected(id, scopeId = 'contract-test') {
  const server = createOfficialMcpServer(id, scopeId);
  assert.ok(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

for (const app of officialMcpApps) {
  test(`${app.id} exposes exact tools and a versioned MCP App home`, async () => {
    const { client, server } = await connected(app.id);
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name), expectedTools[app.id]);
      assert.equal(new Set(listed.tools.map((tool) => tool.name)).size, listed.tools.length);
      for (const tool of listed.tools) {
        assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
        assert.equal(typeof tool.annotations?.destructiveHint, 'boolean');
        assert.equal(typeof tool.annotations?.openWorldHint, 'boolean');
        assert.equal(Object.hasOwn(tool.inputSchema?.properties ?? {}, 'confirmed'), false);
      }
      const home = await client.callTool({ name: 'home', arguments: {} });
      assert.equal(home.structuredContent.schema, 'mahayana.miniapp.home.v1');
      assert.equal(home.structuredContent.app.id, app.id);
      assert.ok(Buffer.byteLength(JSON.stringify(home.structuredContent)) <= 32 * 1024);
      assert.ok(home.structuredContent.feed.items.length <= 10);
      const uri = home._meta?.['ui/resourceUri'];
      assert.match(uri, new RegExp(`^ui://fabushi/${app.id}/home-v1\\.html$`));
      const resource = await client.readResource({ uri });
      assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
      assert.match(resource.contents[0].text, /method:'tools\/call'/);
      assert.match(resource.contents[0].text, /const isResponse=/);
      assert.doesNotMatch(resource.contents[0].text, /if\(message\.id!==undefined&&pending\.has/);
      assert.match(resource.contents[0].text, /Content-Security-Policy/);
      assert.match(resource.contents[0].text, /connect-src 'none'/);
      assert.doesNotMatch(resource.contents[0].text, /FabushiMiniApp|bot\.chat|localhost|127\.0\.0\.1/);
    } finally {
      await client.close();
      await server.close();
    }
  });
}

test('official plugin packages declare exact per-system availability and one server per variant', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const marketplacePath = path.join(root, '.agents/plugins/marketplace.json');
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  assert.equal(marketplace.name, 'fabushi-official');
  assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name), officialMcpApps.map((app) => app.id));
  for (const app of officialMcpApps) {
    const pluginRoot = path.join(root, '.agents/plugins/plugins', app.id);
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
    const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
    assert.equal(manifest.name, app.id);
    assert.equal(manifest.mcpServers, './.mcp.json');
    assert.ok(Array.isArray(manifest.runtimeVariants));
    const covered = new Set();
    for (const variant of manifest.runtimeVariants) {
      assert.ok(mcp.mcpServers[variant.server], `${app.id}:${variant.id} references a missing server`);
      assert.equal(typeof variant.priority, 'number');
      variant.platforms.forEach((platform) => covered.add(platform));
    }
    const local = manifest.runtimeVariants.find((variant) => variant.id === 'local-cli');
    const account = manifest.runtimeVariants.find((variant) => variant.id === 'account-http');
    assert.deepEqual(local.platforms, ['cli', 'desktop']);
    assert.equal(local.server, `${app.id}-local`);
    assert.equal(mcp.mcpServers[local.server].type, 'stdio');
    assert.equal(mcp.mcpServers[local.server].command, './runtime/cli/fabushi-plugin-cli');
    assert.deepEqual(mcp.mcpServers[local.server].args, ['--plugin', app.id, 'mcp-serve']);
    const expectedAccountPlatforms = app.id === 'chatgpt-auto-confirm'
      ? ['cli', 'desktop']
      : ['cli', 'desktop', 'mobile', 'web'];
    assert.deepEqual(account.platforms, expectedAccountPlatforms);
    assert.equal(account.server, app.id);
    assert.equal(mcp.mcpServers[account.server].type, 'http');
    assert.ok(local.priority > account.priority);

    const extension = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mahayana/plugin.json'), 'utf8'));
    assert.equal(extension.runtime.cli.executable, './runtime/cli/fabushi-plugin-cli');
    assert.deepEqual(extension.runtime.cli.args, ['--plugin', app.id]);
    assert.equal(extension.runtime.wasm.module, './runtime/wasm/fabushi_official_miniapps_bg.wasm');
    assert.equal(extension.runtime.wasm.export, 'OfficialMiniAppRuntime');
    assert.deepEqual([...covered].sort(), expectedAccountPlatforms.slice().sort());
  }
});

test('global dharma chat handles quick replies and returns typed host requests', async () => {
  const { client, server } = await connected('global-dharma', 'chat-contract');
  try {
    const home = await client.callTool({ name: 'home', arguments: { surface: 'web', limit: 10 } });
    assert.equal(home.structuredContent.quickReplies[0].aliases[0], '1');
    const guide = home.structuredContent.feed.items.find((item) => item.kind === 'article');
    const article = await client.readResource({ uri: guide.resourceUri });
    assert.equal(article.contents[0].mimeType, 'text/markdown');

    const selected = await client.callTool({ name: 'chat', arguments: { message: '1', surface: 'web' } });
    assert.equal(selected.structuredContent.handled, true);
    await client.callTool({ name: 'chat', arguments: { message: '愿一切众生离苦得乐' } });
    const confirmed = await client.callTool({ name: 'chat', arguments: { message: '确认发送' } });
    assert.equal(confirmed.structuredContent.hostRequest.transport, 'mcp-host-bridge');
    assert.equal(confirmed.structuredContent.hostRequest.capability, 'network.send');
  } finally {
    await client.close();
    await server.close();
  }
});

test('Streamable HTTP keeps one isolated MCP session until DELETE', async () => {
  const app = express();
  app.use(express.json());
  app.all('/mcp/:id', (req, res) => handleOfficialMcpRequest(
    req.params.id,
    req,
    res,
    req.get('x-test-scope') || 'scope-a',
  ));
  const listener = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const address = listener.address();
  const endpoint = `http://127.0.0.1:${address.port}/mcp/global-dharma`;
  try {
    const initialized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'http-contract-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get('mcp-session-id');
    assert.ok(sessionId);

    const noSession = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(noSession.status, 400);

    const sessionHeaders = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': '2025-06-18',
    };
    const listed = await fetch(endpoint, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    assert.equal(listed.status, 200);
    const listedPayload = await listed.json();
    assert.deepEqual(listedPayload.result.tools.map((tool) => tool.name), expectedTools['global-dharma']);

    const wrongPlugin = await fetch(endpoint.replace('global-dharma', 'platform-publish'), {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    assert.equal(wrongPlugin.status, 404);

    const wrongAccount = await fetch(endpoint, {
      method: 'POST',
      headers: { ...sessionHeaders, 'x-test-scope': 'scope-b' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    assert.equal(wrongAccount.status, 403);

    const deleted = await fetch(endpoint, { method: 'DELETE', headers: sessionHeaders });
    assert.ok(deleted.status >= 200 && deleted.status < 300);
    const afterDelete = await fetch(endpoint, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    });
    assert.equal(afterDelete.status, 404);
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test('business state is namespaced by account and plugin identity', async () => {
  const first = await connected('faliu-flashcards', 'account:first');
  const second = await connected('faliu-flashcards', 'account:second');
  try {
    await first.client.callTool({
      name: 'create_deck',
      arguments: { title: '第一账户', cards: [] },
    });
    const firstDecks = await first.client.callTool({ name: 'list_decks', arguments: {} });
    const secondDecks = await second.client.callTool({ name: 'list_decks', arguments: {} });
    assert.equal(firstDecks.structuredContent.decks.length, 1);
    assert.equal(secondDecks.structuredContent.decks.length, 0);
  } finally {
    await first.client.close();
    await first.server.close();
    await second.client.close();
    await second.server.close();
  }
});

test('Bot Father creates a complete portable plugin bundle', async () => {
  const { client, server } = await connected('bot-father');
  try {
    const created = await client.callTool({
      name: 'create_plugin',
      arguments: { name: 'Lotus Notes', description: '莲华笔记' },
    });
    const bundle = created.structuredContent.bundle;
    const requiredFiles = [
      '.codex-plugin/plugin.json',
      '.mcp.json',
      'package.json',
      'server/index.js',
      'ui/home.html',
      'test/contract.test.js',
      'deploy/Dockerfile',
    ];
    requiredFiles.forEach((file) => assert.equal(typeof bundle.files[file], 'string', file));
    const manifest = JSON.parse(bundle.files['.codex-plugin/plugin.json']);
    const mcp = JSON.parse(bundle.files['.mcp.json']);
    assert.equal(manifest.name, 'lotus-notes');
    assert.equal(manifest.mcpServers, './.mcp.json');
    for (const variant of manifest.runtimeVariants) assert.ok(mcp.mcpServers[variant.server]);
    assert.match(bundle.files['ui/home.html'], /method:'tools\/call'/);
    assert.doesNotMatch(JSON.stringify(bundle), /FabushiMiniApp|bot\.chat|confirmed/);

    const validated = await client.callTool({
      name: 'validate_plugin',
      arguments: { plugin_id: created.structuredContent.pluginId },
    });
    assert.equal(validated.structuredContent.valid, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('Bot Father desktop approval profile declares host-only permissions', async () => {
  const { client, server } = await connected('bot-father', 'desktop-profile');
  try {
    const created = await client.callTool({
      name: 'create_plugin',
      arguments: {
        name: 'Approval Helper',
        description: '桌面授权助手',
        profile: 'desktop-approval',
      },
    });
    const bundle = created.structuredContent.bundle;
    const extension = JSON.parse(bundle.files['.mahayana/plugin.json']);
    assert.equal(bundle.profile, 'desktop-approval');
    assert.deepEqual(extension.miniapp.permissions, [
      'mcp.call',
      'storage.local',
      'desktop.accessibility',
      'desktop.chatgpt.approvals',
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('ChatGPT auto confirm emits only scoped desktop host requests', async () => {
  const { client, server } = await connected('chatgpt-auto-confirm', 'approval-contract');
  try {
    const started = await client.callTool({
      name: 'start',
      arguments: {
        rules: [{
          application: 'GitHub',
          action: 'Enable auto-merge',
          resource: 'bhrumom/fabushi',
        }],
      },
    });
    assert.equal(
      started.structuredContent.hostRequest.capability,
      'desktop.chatgpt-approvals.start',
    );
    assert.equal(started.structuredContent.hostRequest.approval, 'required');
    const status = await client.callTool({ name: 'status', arguments: {} });
    assert.equal(status.structuredContent.hostRequest.approval, 'none');
    const sent = await client.callTool({
      name: 'send_and_watch',
      arguments: { message: '只读检查', connector: 'devspace1' },
    });
    assert.equal(
      sent.structuredContent.hostRequest.capability,
      'desktop.chatgpt-approvals.send-and-watch',
    );
    assert.equal(sent.structuredContent.hostRequest.params.connector, 'devspace1');
    const reply = await client.callTool({ name: 'get_reply', arguments: {} });
    assert.equal(
      reply.structuredContent.hostRequest.capability,
      'desktop.chatgpt-approvals.get-reply',
    );
    assert.equal(reply.structuredContent.hostRequest.approval, 'none');
    const queued = await client.callTool({
      name: 'enqueue_tasks',
      arguments: {
        tasks: [{
          id: 'release', title: '发布', prompt: '完成发布',
          resourceLocks: ['repo:fabushi'],
        }],
        maxConcurrent: 2,
      },
    });
    assert.equal(
      queued.structuredContent.hostRequest.capability,
      'desktop.chatgpt-approvals.queue-enqueue',
    );
    assert.deepEqual(
      queued.structuredContent.hostRequest.params.tasks[0].resourceLocks,
      ['repo:fabushi'],
    );
    const wait = await client.callTool({
      name: 'wait_for_review', arguments: { timeout: 60 },
    });
    assert.equal(wait.structuredContent.hostRequest.approval, 'none');
    const retried = await client.callTool({
      name: 'retry_task', arguments: { taskId: 'release', feedback: '从落盘进度续作' },
    });
    assert.equal(
      retried.structuredContent.hostRequest.capability,
      'desktop.chatgpt-approvals.queue-retry',
    );
    const templates = await client.callTool({ name: 'prompt_templates', arguments: {} });
    assert.equal(templates.structuredContent.reportProtocol.protocol, 'mahayana.task-report.v1');
    const unsafe = await client.callTool({
      name: 'start',
      arguments: {
        rules: [{ application: 'GitHub', action: '*', resource: 'bhrumom/fabushi' }],
      },
    });
    assert.equal(unsafe.isError, true);
    assert.equal(unsafe.structuredContent?.hostRequest, undefined);

    const broad = await client.callTool({
      name: 'start',
      arguments: { approveAll: true },
    });
    assert.equal(broad.structuredContent.hostRequest.params.approveAll, true);
    assert.deepEqual(broad.structuredContent.hostRequest.params.rules, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test('active backend source no longer registers the legacy mini-app protocol', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const serverSource = fs.readFileSync(path.join(root, 'ai-backend/src/server.js'), 'utf8');
  assert.doesNotMatch(serverSource, /\/api\/miniapps|generate-miniapp|window\.FabushiMiniApp|bot\.chat/);
});
