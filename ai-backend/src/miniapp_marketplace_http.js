import path from 'node:path';
import process from 'node:process';

import express from 'express';

import { AccountSyncStore } from './account_sync_store.js';
import { readGlobalDharmaEntitlement } from './global_dharma_entitlement.js';
import { GlobalDharmaRuntimeStore } from './global_dharma_runtime_store.js';
import {
  legacySessionScope,
  resolveMarketplaceAccountIdentity,
} from './marketplace_account_identity.js';
import {
  MINIAPP_MARKETPLACE_PROTOCOL,
  MiniAppMarketplace,
  MiniAppMarketplaceError,
  renderMiniAppHomeDocument,
} from './miniapp_marketplace.js';
import {
  browseMarketplace,
  marketplaceReleaseResponse,
  officialMiniAppPackageSeeds,
} from './miniapp_marketplace_catalog.js';
import {
  commandDispatch,
  publicBaseUrl,
  requireManifest,
  reviewAuthorized,
  route,
  safeQuery,
} from './miniapp_marketplace_server_common.js';
import {
  createMarketplaceMcpServer,
  createMiniAppBotMcpServer,
  handleMcpRequest,
} from './miniapp_marketplace_mcp.js';

const MAX_JSON_BYTES = '1mb';
const clone = (value) => JSON.parse(JSON.stringify(value));

function bearerToken(req) {
  const header = String(req.get?.('authorization') ?? req.headers?.authorization ?? '').trim();
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
}

function hasBearer(req) {
  return Boolean(bearerToken(req));
}

function publisherFromIdentity(identity, body = {}) {
  const supplied = body.publisher && typeof body.publisher === 'object' ? body.publisher : {};
  return {
    id: identity.publisherId,
    displayName: String(supplied.displayName ?? supplied.name ?? body.publisherName ?? 'Fabushi Publisher').trim().slice(0, 120),
    website: supplied.website,
    verified: false,
  };
}

export function createMiniAppMarketplaceRouter({
  dataDir,
  storagePath,
  store,
  accountSyncStore,
  resolveUser = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const resolvedDataDir = dataDir ?? process.env.DATA_DIR ?? process.cwd();
  const marketplace = store ?? new MiniAppMarketplace({
    storagePath: storagePath ?? path.join(resolvedDataDir, 'miniapps', 'marketplace-v2.json'),
    seed: officialMiniAppPackageSeeds(),
  });
  const syncStore = accountSyncStore ?? new AccountSyncStore({ dataDir: resolvedDataDir });
  const globalDharmaRuntimeStore = new GlobalDharmaRuntimeStore({ accountSyncStore: syncStore });
  const router = express.Router();
  router.use(express.json({ limit: MAX_JSON_BYTES }));

  async function identityFor(req, { accountRequired = false, publicRead = false } = {}) {
    return resolveMarketplaceAccountIdentity(req, {
      requireAuthenticated: accountRequired || (!publicRead && hasBearer(req)),
      resolveUser,
      fetchImpl,
    });
  }

  function entitlementResolverFor(req) {
    const token = bearerToken(req);
    return ({ capability }) => readGlobalDharmaEntitlement({ token, capability, fetchImpl });
  }

  function syncInstalledApps(identity) {
    if (!identity.accountId) return marketplace.added(identity.scopeId);
    return syncStore.listMiniAppInstalls(identity.accountId)
      .map((install) => marketplace.get(install.miniAppId))
      .filter(Boolean);
  }

  function migrateLegacySession(req, identity) {
    if (!identity.accountId) return;
    const legacyScope = legacySessionScope(req);
    const scopes = [...new Set([legacyScope, identity.scopeId].filter(Boolean))];
    for (const scopeId of scopes) {
      for (const manifest of marketplace.added(scopeId)) {
        syncStore.installMiniApp(identity.accountId, manifest);
      }
    }
  }

  function addToAccount(identity, manifest) {
    if (!identity.accountId) return marketplace.add(manifest.id, identity.scopeId);
    const synced = syncStore.installMiniApp(identity.accountId, manifest);
    // Stable-scope mirror keeps older Marketplace/MCP readers compatible while
    // account_sync_store is the cross-device source of truth.
    marketplace.add(manifest.id, identity.scopeId);
    return {
      added: true,
      changed: synced.changed,
      miniApp: manifest,
      bot: manifest.bot,
      release: marketplaceReleaseResponse(manifest),
    };
  }

  function removeFromAccount(identity, miniAppId) {
    if (!identity.accountId) return marketplace.remove(miniAppId, identity.scopeId);
    const removed = syncStore.removeMiniApp(identity.accountId, miniAppId);
    marketplace.remove(miniAppId, identity.scopeId);
    return removed;
  }

  function browseForIdentity(identity, options, baseUrl) {
    const payload = browseMarketplace(marketplace, { ...options, scopeId: identity.scopeId }, baseUrl);
    if (!identity.accountId) return payload;
    const installed = new Set(syncStore.listMiniAppInstalls(identity.accountId).map((entry) => entry.miniAppId));
    return {
      ...payload,
      plugins: payload.plugins.map((plugin) => ({ ...plugin, added: installed.has(plugin.pluginId) })),
    };
  }

  function mcpAccountState(identity) {
    if (!identity.accountId) return null;
    return {
      browse(options, baseUrl) {
        return browseForIdentity(identity, options, baseUrl);
      },
      add(miniAppId) {
        return addToAccount(identity, requireManifest(marketplace, miniAppId));
      },
      remove(miniAppId) {
        return removeFromAccount(identity, miniAppId);
      },
      added() {
        return syncInstalledApps(identity);
      },
    };
  }

  router.get('/v1/marketplace/plugins', route(async (req, res) => {
    const identity = await identityFor(req, { publicRead: true });
    if (identity.accountId) migrateLegacySession(req, identity);
    const payload = browseForIdentity(identity, {
      query: safeQuery(req.query.q ?? req.query.query),
      platform: safeQuery(req.query.platform, 32) || undefined,
      limit: Number(req.query.limit ?? 50),
    }, publicBaseUrl(req));
    res.json(payload);
  }));

  router.get('/v1/marketplace/plugins/:pluginId', route(async (req, res) => {
    const manifest = requireManifest(marketplace, req.params.pluginId);
    res.json({ miniApp: manifest, release: marketplaceReleaseResponse(manifest, safeQuery(req.query.platform, 32) || 'desktop') });
  }));

  router.get('/v1/marketplace/plugins/:pluginId/releases/:version', route(async (req, res) => {
    const manifest = requireManifest(marketplace, req.params.pluginId);
    if (manifest.version !== req.params.version) {
      throw new MiniAppMarketplaceError('NOT_FOUND', `release ${req.params.version} was not found`);
    }
    res.json(marketplaceReleaseResponse(manifest, safeQuery(req.query.platform, 32) || 'desktop'));
  }));

  router.get('/v1/marketplace/plugins/:pluginId/commands', route(async (req, res) => {
    res.json({ miniAppId: req.params.pluginId, commands: marketplace.commands(req.params.pluginId) });
  }));

  router.post('/v1/marketplace/plugins/:pluginId/add', route(async (req, res) => {
    const identity = await identityFor(req);
    if (identity.accountId) migrateLegacySession(req, identity);
    const manifest = requireManifest(marketplace, req.params.pluginId);
    const added = addToAccount(identity, manifest);
    res.status(201).json({
      ...added,
      release: marketplaceReleaseResponse(manifest, safeQuery(req.body?.platform, 32) || 'desktop'),
      botEndpoint: `${publicBaseUrl(req)}/api/mcp/miniapp-bot/${encodeURIComponent(manifest.id)}`,
      accountSynchronized: Boolean(identity.accountId),
    });
  }));

  router.delete('/v1/marketplace/plugins/:pluginId/add', route(async (req, res) => {
    const identity = await identityFor(req);
    if (identity.accountId) migrateLegacySession(req, identity);
    res.json(removeFromAccount(identity, req.params.pluginId));
  }));

  router.get('/v1/marketplace/added', route(async (req, res) => {
    const identity = await identityFor(req);
    if (identity.accountId) migrateLegacySession(req, identity);
    res.json({
      protocol: MINIAPP_MARKETPLACE_PROTOCOL,
      apps: syncInstalledApps(identity),
      accountSynchronized: Boolean(identity.accountId),
      cursor: identity.accountId ? syncStore.currentCursor(identity.accountId) : null,
    });
  }));

  router.get('/v1/account/sync', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    migrateLegacySession(req, identity);
    const payload = syncStore.sync(identity.accountId, safeQuery(req.query.cursor, 120) || null, Number(req.query.limit ?? 200));
    if (payload.snapshot) {
      payload.snapshot.miniApps = payload.snapshot.miniApps.map((entry) => ({
        ...entry,
        miniApp: marketplace.get(entry.miniAppId),
      }));
    }
    res.json(payload);
  }));

  router.get('/v1/account/bots', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    migrateLegacySession(req, identity);
    res.json({ bots: syncStore.listBots(identity.accountId), cursor: syncStore.currentCursor(identity.accountId) });
  }));

  router.post('/v1/account/bots/:botId/add', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const profile = {
      ...(req.body?.bot && typeof req.body.bot === 'object' ? req.body.bot : req.body ?? {}),
      id: req.params.botId,
    };
    res.status(201).json(syncStore.addBot(identity.accountId, profile, { source: 'manual', sourceId: 'manual' }));
  }));

  router.delete('/v1/account/bots/:botId/add', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    res.json(syncStore.removeBot(identity.accountId, req.params.botId, { source: 'manual', sourceId: 'manual' }));
  }));

  router.get('/v1/miniapps/:pluginId/cloud-storage', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    requireManifest(marketplace, req.params.pluginId);
    const key = safeQuery(req.query.key, 128);
    if (key) {
      res.json({ miniAppId: req.params.pluginId, item: syncStore.getCloudValue(identity.accountId, req.params.pluginId, key) });
      return;
    }
    res.json({ miniAppId: req.params.pluginId, items: syncStore.listCloudValues(identity.accountId, req.params.pluginId) });
  }));

  router.put('/v1/miniapps/:pluginId/cloud-storage', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    requireManifest(marketplace, req.params.pluginId);
    const values = req.body?.values && typeof req.body.values === 'object' && !Array.isArray(req.body.values)
      ? Object.entries(req.body.values)
      : [[req.body?.key, req.body?.value]];
    if (values.length < 1 || values.length > 100) throw new MiniAppMarketplaceError('INVALID_CLOUD_STORAGE', '1-100 CloudStorage values are required');
    const items = values.map(([key, value]) => syncStore.setCloudValue(identity.accountId, req.params.pluginId, key, value));
    res.json({ miniAppId: req.params.pluginId, items, cursor: syncStore.currentCursor(identity.accountId) });
  }));

  router.delete('/v1/miniapps/:pluginId/cloud-storage', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    requireManifest(marketplace, req.params.pluginId);
    const key = safeQuery(req.query.key ?? req.body?.key, 128);
    if (!key) throw new MiniAppMarketplaceError('INVALID_CLOUD_STORAGE', 'CloudStorage key is required');
    res.json(syncStore.deleteCloudValue(identity.accountId, req.params.pluginId, key));
  }));

  router.get('/v1/miniapps/:pluginId/runtime', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const manifest = requireManifest(marketplace, req.params.pluginId);
    if (manifest.id !== 'global-dharma') {
      throw new MiniAppMarketplaceError('RUNTIME_UNAVAILABLE', `shared runtime is not configured for ${manifest.id}`);
    }
    res.json(globalDharmaRuntimeStore.snapshot(identity.accountId));
  }));

  router.get('/v1/miniapps/:pluginId/runtime/difference', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const manifest = requireManifest(marketplace, req.params.pluginId);
    if (manifest.id !== 'global-dharma') {
      throw new MiniAppMarketplaceError('RUNTIME_UNAVAILABLE', `shared runtime is not configured for ${manifest.id}`);
    }
    res.json(globalDharmaRuntimeStore.difference(
      identity.accountId,
      safeQuery(req.query.cursor, 120) || null,
      Number(req.query.limit ?? 200),
    ));
  }));

  router.get('/v1/miniapps/:pluginId/entitlement/:capability', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const manifest = requireManifest(marketplace, req.params.pluginId);
    if (manifest.id !== 'global-dharma') {
      throw new MiniAppMarketplaceError('ENTITLEMENT_UNAVAILABLE', `entitlement projection is not configured for ${manifest.id}`);
    }
    const access = await entitlementResolverFor(req)({ capability: req.params.capability });
    res.json({ miniAppId: manifest.id, account: { authenticated: true }, access });
  }));

  router.post('/v1/marketplace/plugins/:pluginId/route', route(async (req, res) => {
    const manifest = requireManifest(marketplace, req.params.pluginId);
    const routed = marketplace.routeInput(req.params.pluginId, req.body?.input);
    const payload = routed.kind === 'command'
      ? commandDispatch(manifest, routed.command, routed.arguments)
      : routed.suggestedCommand
        ? commandDispatch(manifest, routed.suggestedCommand, { input: req.body?.input })
        : routed;
    res.json(payload);
  }));

  router.post('/v1/marketplace/botfather/generate', route(async (req, res) => {
    const identity = await identityFor(req);
    const publisher = publisherFromIdentity(identity, req.body ?? {});
    const workflow = marketplace.generationWorkflow({
      prompt: req.body?.prompt,
      publisher,
      id: req.body?.id,
      title: req.body?.title,
      description: req.body?.description,
      surfaces: req.body?.surfaces,
      repository: req.body?.repository,
    });
    let draft = null;
    if (req.body?.manifest) {
      draft = marketplace.createDraft({
        ...clone(req.body.manifest),
        id: workflow.miniAppId,
        title: workflow.spec.title,
        description: workflow.spec.description,
        publisher,
        distribution: {
          ...(req.body.manifest.distribution ?? {}),
          repository: workflow.spec.repository,
        },
      });
      if (req.body?.submitForReview === true) draft = marketplace.submit(draft.id, publisher.id);
    }
    res.status(201).json({ workflow, draft });
  }));

  router.post('/v1/marketplace/publisher/drafts', route(async (req, res) => {
    const identity = await identityFor(req);
    const publisher = publisherFromIdentity(identity, req.body ?? {});
    const draft = marketplace.createDraft({ ...req.body, publisher });
    res.status(201).json({ miniApp: draft });
  }));

  router.post('/v1/marketplace/publisher/:pluginId/submit', route(async (req, res) => {
    const identity = await identityFor(req);
    res.json({ miniApp: marketplace.submit(req.params.pluginId, identity.publisherId) });
  }));

  router.post('/v1/marketplace/review/:pluginId', route(async (req, res) => {
    if (!reviewAuthorized(req)) {
      throw new MiniAppMarketplaceError('REVIEW_AUTH_REQUIRED', 'marketplace reviewer authorization is required');
    }
    res.json({
      miniApp: marketplace.review(req.params.pluginId, {
        approved: req.body?.approved === true,
        reviewer: req.body?.reviewer,
        notes: req.body?.notes,
      }),
    });
  }));

  router.post('/v1/marketplace/publisher/:pluginId/yank', route(async (req, res) => {
    const identity = await identityFor(req);
    res.json({ miniApp: marketplace.yank(req.params.pluginId, identity.publisherId, req.body?.notes) });
  }));

  router.get('/v1/marketplace/miniapps/:pluginId/ui', route(async (req, res) => {
    const manifest = requireManifest(marketplace, req.params.pluginId);
    res.type('html').set('Cache-Control', 'public, max-age=300').send(renderMiniAppHomeDocument(manifest));
  }));

  router.all('/api/mcp/miniapp-marketplace', route(async (req, res) => {
    const identity = await identityFor(req);
    if (identity.accountId) migrateLegacySession(req, identity);
    const baseUrl = publicBaseUrl(req);
    await handleMcpRequest({
      endpoint: 'miniapp-marketplace',
      req,
      res,
      scopeId: identity.scopeId,
      createServer: () => createMarketplaceMcpServer(marketplace, identity.scopeId, baseUrl, mcpAccountState(identity)),
    });
  }));

  router.all('/api/mcp/miniapp-bot/:pluginId', route(async (req, res) => {
    const id = req.params.pluginId;
    const identity = await identityFor(req, { accountRequired: id === 'global-dharma' });
    const baseUrl = publicBaseUrl(req);
    requireManifest(marketplace, id);
    await handleMcpRequest({
      endpoint: `miniapp-bot:${id}`,
      req,
      res,
      scopeId: identity.scopeId,
      createServer: () => createMiniAppBotMcpServer(marketplace, identity.scopeId, id, baseUrl, {
        globalDharmaRuntimeStore,
        runtimeAccountId: identity.accountId ?? identity.scopeId,
        entitlementResolver: entitlementResolverFor(req),
      }),
    });
  }));

  return { router, marketplace, accountSyncStore: syncStore, globalDharmaRuntimeStore };
}

export function registerMiniAppMarketplaceRoutes(app, options = {}) {
  const registration = createMiniAppMarketplaceRouter(options);
  app.use(registration.router);
  return registration;
}
