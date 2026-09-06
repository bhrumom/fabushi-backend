import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { AccountSyncStore } from '../src/account_sync_store.js';
import { GlobalDharmaRuntimeStore } from '../src/global_dharma_runtime_store.js';
import {
  GLOBAL_DHARMA_TOOL_CONTRACT,
  globalDharmaMarketplaceCommands,
} from '../src/global_dharma_tool_contract.js';
import { MiniAppMarketplace, officialMiniAppManifests } from '../src/miniapp_marketplace.js';
import { createMiniAppBotMcpServer } from '../src/miniapp_marketplace_mcp.js';
import { createOfficialMcpServer } from '../src/official_mcp_apps.js';

async function connected(server, name = 'global-dharma-contract-test') {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function tempStores(eventRetention = 32) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-global-dharma-runtime-'));
  const accountSyncStore = new AccountSyncStore({ dataDir: root, eventRetention });
  const runtimeStore = new GlobalDharmaRuntimeStore({ accountSyncStore });
  return {
    root,
    accountSyncStore,
    runtimeStore,
    close() {
      accountSyncStore.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function marketplace(root) {
  return new MiniAppMarketplace({
    storagePath: path.join(root, 'marketplace.json'),
    seed: officialMiniAppManifests(),
  });
}

test('Global Dharma canonical Tool Contract is the live official MCP inventory and Marketplace command source', async () => {
  const { client, server } = await connected(createOfficialMcpServer('global-dharma'));
  try {
    const live = await client.listTools();
    assert.deepEqual(
      live.tools.map((tool) => tool.name),
      GLOBAL_DHARMA_TOOL_CONTRACT.map((tool) => tool.name),
    );
    for (const tool of live.tools) {
      const contract = GLOBAL_DHARMA_TOOL_CONTRACT.find((entry) => entry.name === tool.name);
      assert.ok(contract);
      assert.equal(tool.description, contract.description);
      assert.deepEqual(tool.annotations, contract.annotations);
    }
    assert.deepEqual(
      globalDharmaMarketplaceCommands().map((command) => command.tool),
      GLOBAL_DHARMA_TOOL_CONTRACT.filter((tool) => !['home', 'chat'].includes(tool.name)).map((tool) => tool.name),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('durable runtime is account scoped, monotonic, idempotent, and recoverable from the shared as1 cursor', () => {
  const stores = tempStores(16);
  try {
    const mutateStart = (state) => {
      state.running = true;
      state.logs.push('服务已启动');
      return { content: [{ type: 'text', text: 'started' }], structuredContent: { running: true } };
    };
    const first = stores.runtimeStore.runMutation('user:108', {
      operationId: 'op-start-1', toolName: 'start', args: {}, mutate: mutateStart,
    });
    assert.equal(first.structuredContent.runtime.revision, 1);
    assert.match(first.structuredContent.runtime.cursor, /^as1:\d+$/);
    assert.equal(first.structuredContent.runtime.state.running, true);
    assert.equal(first.structuredContent.runtime.replayed, false);

    const replay = stores.runtimeStore.runMutation('user:108', {
      operationId: 'op-start-1', toolName: 'start', args: {}, mutate: () => {
        throw new Error('idempotent replay must not execute mutation twice');
      },
    });
    assert.equal(replay.structuredContent.runtime.revision, 1);
    assert.equal(replay.structuredContent.runtime.replayed, true);
    assert.equal(stores.runtimeStore.snapshot('user:108').state.logs.length, 1);

    assert.throws(() => stores.runtimeStore.runMutation('user:108', {
      operationId: 'op-start-1', toolName: 'stop', args: {}, mutate: mutateStart,
    }), (error) => error?.code === 'MINIAPP_IDEMPOTENCY_CONFLICT' && error?.statusCode === 409);

    const isolated = stores.runtimeStore.snapshot('user:999');
    assert.equal(isolated.revision, 0);
    assert.equal(isolated.state.running, false);

    const delta = stores.runtimeStore.difference('user:108', 'as1:0');
    assert.equal(delta.mode, 'difference');
    assert.equal(delta.events.length, 1);
    assert.equal(delta.events[0].operationId, 'op-start-1');
    assert.equal(delta.events[0].state.running, true);

    const recovered = stores.runtimeStore.difference('user:108', 'as1:999999');
    assert.equal(recovered.mode, 'snapshot');
    assert.equal(recovered.reason, 'cursor-ahead');
    assert.equal(recovered.runtime.state.running, true);
  } finally {
    stores.close();
  }
});

test('Bot natural language and official WebMCP tools/call converge on the same durable account runtime', async () => {
  const stores = tempStores();
  const market = marketplace(stores.root);
  const bot = await connected(createMiniAppBotMcpServer(
    market,
    'account-scope-108',
    'global-dharma',
    'https://example.test',
    {
      globalDharmaRuntimeStore: stores.runtimeStore,
      runtimeAccountId: 'user:108',
      entitlementResolver: async () => ({ protected: true, allowed: false, reason: 'not_entitled', purchaseOptions: [] }),
    },
  ), 'global-dharma-bot-test');
  const web = await connected(createOfficialMcpServer('global-dharma', 'user:108', {
    globalDharmaRuntimeStore: stores.runtimeStore,
    entitlementResolver: async () => ({ protected: true, allowed: false, reason: 'not_entitled', purchaseOptions: [] }),
  }), 'global-dharma-webmcp-test');
  try {
    const botTools = await bot.client.listTools();
    assert.ok(botTools.tools.some((tool) => tool.name === 'chat'));
    assert.ok(botTools.tools.some((tool) => tool.name === 'start'));

    const fromBot = await bot.client.callTool({ name: 'chat', arguments: { message: '启动服务' } });
    assert.equal(fromBot.structuredContent.runtime.state.running, true);
    assert.equal(fromBot.structuredContent.runtime.revision, 1);

    const fromWeb = await web.client.callTool({ name: 'status', arguments: {} });
    assert.equal(fromWeb.structuredContent.runtime.state.running, true);
    assert.equal(fromWeb.structuredContent.runtime.revision, 1);

    const webMutation = await web.client.callTool({
      name: 'loop',
      arguments: { operationId: 'web-loop-1' },
    });
    assert.equal(webMutation.structuredContent.runtime.state.loops, 1);
    assert.equal(webMutation.structuredContent.runtime.revision, 2);

    const botRead = await bot.client.callTool({ name: 'status', arguments: { arguments: {} } });
    assert.equal(botRead.structuredContent.runtime.state.loops, 1);
    assert.equal(botRead.structuredContent.runtime.revision, 2);
  } finally {
    await bot.client.close();
    await bot.server.close();
    await web.client.close();
    await web.server.close();
    stores.close();
  }
});

test('local prayer wheel is fail-closed without server entitlement and emits a Host request only after entitlement approval', async () => {
  const deniedStores = tempStores();
  const denied = await connected(createOfficialMcpServer('global-dharma', 'user:denied', {
    globalDharmaRuntimeStore: deniedStores.runtimeStore,
    entitlementResolver: async () => ({ protected: true, allowed: false, reason: 'not_entitled', purchaseOptions: [{ currency: 'CNY', amount: 108000 }] }),
  }));
  try {
    await denied.client.callTool({ name: 'chat', arguments: { message: '进入本地转经轮', operationId: 'denied-mode' } });
    const result = await denied.client.callTool({ name: 'chat', arguments: { message: '开始', operationId: 'denied-start' } });
    assert.equal(result.structuredContent.entitlementAccess.allowed, false);
    assert.equal(Object.hasOwn(result.structuredContent, 'hostRequest'), false);
  } finally {
    await denied.client.close();
    await denied.server.close();
    deniedStores.close();
  }

  const allowedStores = tempStores();
  const allowed = await connected(createOfficialMcpServer('global-dharma', 'user:allowed', {
    globalDharmaRuntimeStore: allowedStores.runtimeStore,
    entitlementResolver: async () => ({ protected: true, allowed: true, reason: 'active_durable_entitlement', purchaseOptions: [] }),
  }));
  try {
    await allowed.client.callTool({ name: 'chat', arguments: { message: '进入本地转经轮', operationId: 'allowed-mode' } });
    const result = await allowed.client.callTool({ name: 'chat', arguments: { message: '开始', operationId: 'allowed-start' } });
    assert.equal(result.structuredContent.entitlementAccess.allowed, true);
    assert.equal(result.structuredContent.hostRequest.capability, 'local.prayer-wheel.start');
  } finally {
    await allowed.client.close();
    await allowed.server.close();
    allowedStores.close();
  }
});
