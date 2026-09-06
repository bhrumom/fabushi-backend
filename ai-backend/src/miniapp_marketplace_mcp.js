import crypto from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { MINIAPP_MARKETPLACE_PROTOCOL } from './miniapp_marketplace.js';
import { globalDharmaTool } from './global_dharma_tool_contract.js';
import { createOfficialMcpServer } from './official_mcp_apps.js';
import {
  ALL_PLATFORMS,
  MINIAPP_BOT_PROTOCOL,
  browseMarketplace,
  marketplaceReleaseResponse,
} from './miniapp_marketplace_catalog.js';
import {
  annotations,
  commandDispatch,
  registerMiniAppResource,
  requireManifest,
  result,
} from './miniapp_marketplace_server_common.js';

const SESSION_TTL_MS = 30 * 60_000;
const clone = (value) => JSON.parse(JSON.stringify(value));

function globalDharmaInvocationArgs(toolName, args = {}) {
  const definition = globalDharmaTool(toolName);
  const next = { ...(args ?? {}) };
  if (definition && !definition.annotations.readOnlyHint && !next.operationId && !next.operation_id) {
    next.operationId = crypto.randomUUID();
  }
  return next;
}

async function invokeOfficialGlobalDharma({
  runtimeStore,
  runtimeAccountId,
  entitlementResolver,
  toolName,
  args = {},
}) {
  const server = createOfficialMcpServer('global-dharma', runtimeAccountId, {
    globalDharmaRuntimeStore: runtimeStore,
    entitlementResolver,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'fabushi-global-dharma-bot', version: '1.0.0' },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name: toolName, arguments: globalDharmaInvocationArgs(toolName, args) });
  } finally {
    await client.close();
    await server.close();
  }
}

function naturalLanguageArgs(toolName, message) {
  if (toolName === 'chat') return { message };
  if (toolName === 'send') return { content: message };
  if (toolName === 'validate_config') return { config: {} };
  return {};
}

export function createMarketplaceMcpServer(store, scopeId, baseUrl, accountState = null) {
  const server = new McpServer(
    { name: 'fabushi-miniapp-marketplace', version: '2.0.0' },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } },
  );

  server.registerTool('market_search', {
    title: 'Search Mini App Marketplace',
    description: 'Search approved Fabushi Mini Apps, bots, commands, runtimes, and source metadata.',
    inputSchema: {
      query: z.string().max(240).default(''),
      platform: z.enum(ALL_PLATFORMS).optional(),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: annotations({ readOnly: true, openWorld: true }),
  }, async ({ query, platform, limit }) => {
    const payload = accountState?.browse
      ? accountState.browse({ query, platform, limit }, baseUrl)
      : browseMarketplace(store, { query, platform, limit, scopeId }, baseUrl);
    return result(`Found ${payload.plugins.length} Mini Apps.`, payload);
  });

  server.registerTool('market_add', {
    title: 'Add Mini App',
    description: 'Add an approved Mini App to this Fabushi account and return its default bot and external release metadata.',
    inputSchema: { miniAppId: z.string().min(2).max(64) },
    annotations: annotations({ openWorld: true }),
  }, async ({ miniAppId }) => {
    const added = accountState?.add ? accountState.add(miniAppId) : store.add(miniAppId, scopeId);
    return result(`Added ${added.miniApp.title}.`, {
      ...added,
      release: marketplaceReleaseResponse(added.miniApp),
      botEndpoint: `${baseUrl}/api/mcp/miniapp-bot/${encodeURIComponent(added.miniApp.id)}`,
    });
  });

  server.registerTool('market_remove', {
    title: 'Remove Mini App',
    description: 'Remove a Mini App from this Fabushi account without deleting publisher source artifacts.',
    inputSchema: { miniAppId: z.string().min(2).max(64) },
    annotations: annotations({ destructive: true }),
  }, async ({ miniAppId }) => result(
    'Mini App removed.',
    accountState?.remove ? accountState.remove(miniAppId) : store.remove(miniAppId, scopeId),
  ));

  server.registerTool('added_apps', {
    title: 'List Added Mini Apps',
    description: 'List Mini Apps currently added to this Fabushi account.',
    annotations: annotations({ readOnly: true }),
  }, async () => result('Loaded added Mini Apps.', {
    protocol: MINIAPP_MARKETPLACE_PROTOCOL,
    apps: accountState?.added ? accountState.added() : store.added(scopeId),
  }));

  server.registerTool('app_commands', {
    title: 'List Mini App Commands',
    description: 'List slash commands declared by a Mini App MCP or CLI surface.',
    inputSchema: { miniAppId: z.string().min(2).max(64) },
    annotations: annotations({ readOnly: true }),
  }, async ({ miniAppId }) => result('Loaded Mini App commands.', {
    miniAppId,
    commands: store.commands(miniAppId),
  }));

  server.registerTool('route_app_input', {
    title: 'Route Mini App Input',
    description: 'Resolve natural language or a slash command to a Mini App command and execution surface.',
    inputSchema: {
      miniAppId: z.string().min(2).max(64),
      input: z.string().min(1).max(10_000),
    },
    annotations: annotations({ openWorld: true }),
  }, async ({ miniAppId, input }) => {
    const manifest = requireManifest(store, miniAppId);
    const routed = store.routeInput(miniAppId, input);
    if (routed.kind === 'command') {
      return result('Resolved slash command.', commandDispatch(manifest, routed.command, routed.arguments));
    }
    const dispatch = routed.suggestedCommand
      ? commandDispatch(manifest, routed.suggestedCommand, { input })
      : routed;
    return result('Resolved natural-language Mini App intent.', dispatch);
  });

  server.registerTool('generate_and_submit_miniapp', {
    title: 'Generate and Submit Mini App',
    description: 'Create a Mahayana multi-step build workflow, persist a source-backed draft, and submit it for marketplace review.',
    inputSchema: {
      prompt: z.string().min(10).max(10_000),
      id: z.string().min(2).max(64),
      title: z.string().min(1).max(120),
      description: z.string().min(1).max(500),
      publisherName: z.string().min(1).max(120).default('Fabushi Publisher'),
      repository: z.string().url(),
      surfaces: z.array(z.enum(['web', 'mcp-http', 'mcp-stdio', 'cli', 'wasm', 'native'])).min(1).max(6),
      manifest: z.record(z.unknown()).optional(),
      submitForReview: z.boolean().default(true),
    },
    annotations: annotations({ openWorld: true }),
  }, async (input) => {
    const publisher = {
      id: String(accountState?.publisherId ?? scopeId.replace(/^scope-/, 'publisher-')).slice(0, 64),
      displayName: input.publisherName,
    };
    const workflow = store.generationWorkflow({
      prompt: input.prompt,
      publisher,
      id: input.id,
      title: input.title,
      description: input.description,
      surfaces: input.surfaces,
      repository: input.repository,
    });
    let draft = null;
    if (input.manifest) {
      draft = store.createDraft({
        ...clone(input.manifest),
        id: input.id,
        title: input.title,
        description: input.description,
        publisher,
        distribution: {
          ...(input.manifest.distribution ?? {}),
          repository: input.repository,
        },
      });
      if (input.submitForReview) draft = store.submit(draft.id, publisher.id);
    }
    return result('Created Mahayana Mini App generation workflow.', { workflow, draft });
  });

  server.registerTool('open_app', {
    title: 'Open Mini App GUI',
    description: 'Return the graphical Mini App URL and default bot endpoint.',
    inputSchema: { miniAppId: z.string().min(2).max(64) },
    annotations: annotations({ readOnly: true }),
  }, async ({ miniAppId }) => {
    const manifest = requireManifest(store, miniAppId);
    return result(`Open ${manifest.title}.`, {
      miniAppId,
      uiUrl: `${baseUrl}/v1/marketplace/miniapps/${encodeURIComponent(miniAppId)}/ui`,
      bot: manifest.bot,
      botEndpoint: `${baseUrl}/api/mcp/miniapp-bot/${encodeURIComponent(miniAppId)}`,
    });
  });

  return server;
}

export function createMiniAppBotMcpServer(store, scopeId, miniAppId, baseUrl, {
  globalDharmaRuntimeStore = null,
  runtimeAccountId = scopeId,
  entitlementResolver = null,
} = {}) {
  const manifest = requireManifest(store, miniAppId);
  const server = new McpServer(
    { name: `fabushi-miniapp-bot-${manifest.id}`, version: manifest.version },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } },
  );
  const uri = registerMiniAppResource(server, manifest);

  server.registerTool('home', {
    title: `Open ${manifest.title}`,
    description: `Open the graphical interface for ${manifest.title}.`,
    annotations: annotations({ readOnly: true }),
    _meta: { 'ui/resourceUri': uri },
  }, async () => ({
    ...result(manifest.description, {
      protocol: MINIAPP_BOT_PROTOCOL,
      miniApp: manifest,
      commands: store.commands(manifest.id),
      uiUrl: `${baseUrl}/v1/marketplace/miniapps/${encodeURIComponent(manifest.id)}/ui`,
    }),
    _meta: { 'ui/resourceUri': uri },
  }));

  server.registerTool('commands', {
    title: 'Show Slash Commands',
    description: 'Equivalent to entering / in the Mini App bot composer.',
    annotations: annotations({ readOnly: true }),
  }, async () => result('Loaded slash commands.', {
    miniAppId: manifest.id,
    commands: store.commands(manifest.id),
  }));

  server.registerTool('chat', {
    title: 'Natural Language Mini App Control',
    description: 'Resolve natural language against the current Mini App Tool Contract and execute the selected tool.',
    inputSchema: { message: z.string().min(1).max(10_000) },
    annotations: annotations({ openWorld: true }),
  }, async ({ message }) => {
    const routed = store.routeInput(manifest.id, message);
    if (manifest.id === 'global-dharma' && globalDharmaRuntimeStore) {
      const selected = routed.kind === 'command'
        ? routed.command
        : routed.suggestedCommand;
      const toolName = selected?.tool ?? selected?.name ?? 'chat';
      const args = routed.kind === 'command'
        ? routed.arguments
        : naturalLanguageArgs(toolName, message);
      return invokeOfficialGlobalDharma({
        runtimeStore: globalDharmaRuntimeStore,
        runtimeAccountId,
        entitlementResolver,
        toolName,
        args,
      });
    }
    const payload = routed.kind === 'command'
      ? commandDispatch(manifest, routed.command, routed.arguments)
      : routed.suggestedCommand
        ? commandDispatch(manifest, routed.suggestedCommand, { input: message })
        : routed;
    return result('Mini App bot routed the request.', payload);
  });

  server.registerTool('open_app', {
    title: 'Open Graphical Interface',
    description: 'Open the Mini App graphical interface while preserving this bot conversation.',
    annotations: annotations({ readOnly: true }),
    _meta: { 'ui/resourceUri': uri },
  }, async () => ({
    ...result(`Open ${manifest.title}.`, {
      miniAppId: manifest.id,
      uiUrl: `${baseUrl}/v1/marketplace/miniapps/${encodeURIComponent(manifest.id)}/ui`,
    }),
    _meta: { 'ui/resourceUri': uri },
  }));

  for (const command of manifest.commands) {
    const globalDefinition = manifest.id === 'global-dharma' ? globalDharmaTool(command.tool ?? command.name) : null;
    server.registerTool(command.name, {
      title: command.name,
      description: command.description,
      inputSchema: { arguments: z.record(z.unknown()).default({}) },
      annotations: globalDefinition?.annotations ?? annotations({
        destructive: command.approval === 'destructive',
        openWorld: true,
      }),
    }, async ({ arguments: args }) => {
      if (manifest.id === 'global-dharma' && globalDharmaRuntimeStore) {
        return invokeOfficialGlobalDharma({
          runtimeStore: globalDharmaRuntimeStore,
          runtimeAccountId,
          entitlementResolver,
          toolName: command.tool ?? command.name,
          args,
        });
      }
      return result(
        `Prepared /${manifest.id}:${command.name}.`,
        commandDispatch(manifest, command, args),
      );
    });
  }

  return server;
}

class MemoryEventStore {
  constructor() {
    this.events = new Map();
  }

  async storeEvent(streamId, message) {
    const eventId = `${streamId}_${Date.now()}_${crypto.randomUUID()}`;
    this.events.set(eventId, { streamId, message });
    return eventId;
  }

  async replayEventsAfter(lastEventId, { send }) {
    const previous = this.events.get(lastEventId);
    if (!previous) return '';
    let replay = false;
    for (const [eventId, event] of this.events) {
      if (event.streamId !== previous.streamId) continue;
      if (eventId === lastEventId) {
        replay = true;
        continue;
      }
      if (replay) await send(eventId, event.message);
    }
    return previous.streamId;
  }
}

const mcpSessions = new Map();

function mcpSessionKey(endpoint, sessionId) {
  return `${endpoint}:${sessionId}`;
}

export async function handleMcpRequest({ endpoint, createServer, req, res, scopeId }) {
  const suppliedSessionId = req.headers['mcp-session-id'];
  const key = suppliedSessionId ? mcpSessionKey(endpoint, suppliedSessionId) : '';
  let session = key ? mcpSessions.get(key) : null;

  if (session && session.scopeId !== scopeId) {
    res.status(403).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32001, message: 'MCP session belongs to a different Fabushi scope' },
    });
    return;
  }

  if (!session && req.method === 'POST' && !suppliedSessionId && isInitializeRequest(req.body)) {
    const server = createServer();
    let transport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      eventStore: new MemoryEventStore(),
      onsessioninitialized: (newSessionId) => {
        const sessionKey = mcpSessionKey(endpoint, newSessionId);
        session = { server, transport, scopeId, touchedAt: Date.now() };
        mcpSessions.set(sessionKey, session);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) mcpSessions.delete(mcpSessionKey(endpoint, transport.sessionId));
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (!session) {
    res.status(suppliedSessionId ? 404 : 400).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: {
        code: -32000,
        message: suppliedSessionId
          ? 'MCP session not found'
          : 'Initialize the MCP session before making this request',
      },
    });
    return;
  }

  session.touchedAt = Date.now();
  await session.transport.handleRequest(req, res, req.body);
}

const sessionReaper = setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, session] of mcpSessions) {
    if (session.touchedAt >= cutoff) continue;
    mcpSessions.delete(key);
    void session.transport.close();
  }
}, 60_000);
sessionReaper.unref();

