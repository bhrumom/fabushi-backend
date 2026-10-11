import path from 'node:path';
import process from 'node:process';

import express from 'express';

import {
  browseExtensions,
  ExtensionRegistryError,
  readExtension,
} from './extension_registry.js';
import {
  ExtensionPublisherStore,
  ExtensionPublisherStoreError,
} from './extension_publisher_store.js';
import {
  ExtensionReleaseStore,
  ExtensionReleaseStoreError,
  extensionReleaseErrorFromRegistry,
} from './extension_release_store.js';
import {
  ExtensionArtifactStore,
  ExtensionArtifactStoreError,
} from './extension_artifact_store.js';
import {
  ExtensionSigningStore,
  ExtensionSigningStoreError,
} from './extension_signing_store.js';
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
  const extensionPublisherStore = new ExtensionPublisherStore({ db: syncStore.db });
  const extensionReleaseStore = new ExtensionReleaseStore({ db: syncStore.db, publisherStore: extensionPublisherStore });
  const extensionArtifactStore = new ExtensionArtifactStore({
    db: syncStore.db,
    dataDir: resolvedDataDir,
    publisherStore: extensionPublisherStore,
    releaseStore: extensionReleaseStore,
  });
  extensionReleaseStore.setArtifactStore(extensionArtifactStore);
  const extensionSigningStore = new ExtensionSigningStore({ db: syncStore.db });
  extensionReleaseStore.setSigningStore(extensionSigningStore);
  extensionArtifactStore.setSigningStore(extensionSigningStore);
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

  function extensionErrorStatus(error) {
    if (!(error instanceof ExtensionRegistryError)) return 500;
    if (error.code === 'EXTENSION_NOT_FOUND') return 404;
    if (error.code === 'STALE_EXTENSION_CURSOR') return 409;
    return 400;
  }

  function extensionRoute(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        const status = extensionErrorStatus(error);
        res.status(status).json({
          success: false,
          error: {
            code: error?.code ?? 'EXTENSION_REGISTRY_ERROR',
            message: status >= 500 ? 'Extension registry operation failed' : String(error?.message ?? error),
          },
        });
      }
    };
  }

  function publisherErrorStatus(error) {
    if (!(error instanceof ExtensionPublisherStoreError)) return 500;
    if (error.code === 'NAMESPACE_NOT_FOUND') return 404;
    if (error.code === 'NAMESPACE_CONFLICT' || error.code === 'TRANSFER_NOT_PENDING') return 409;
    if (error.code === 'NAMESPACE_FORBIDDEN' || error.code === 'TRANSFER_FORBIDDEN') return 403;
    return 400;
  }

  function publisherRoute(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        const status = publisherErrorStatus(error);
        res.status(status).json({
          success: false,
          error: {
            code: error?.code ?? 'EXTENSION_PUBLISHER_ERROR',
            message: status >= 500 ? 'Extension publisher operation failed' : String(error?.message ?? error),
          },
        });
      }
    };
  }

  router.get('/v1/extensions/namespaces/:namespace', publisherRoute(async (req, res) => {
    const namespace = extensionPublisherStore.getPublic(req.params.namespace);
    if (!namespace) {
      throw new ExtensionPublisherStoreError('NAMESPACE_NOT_FOUND', 'namespace was not found');
    }
    res.json({ namespace });
  }));

  router.get('/v1/extensions/publisher/namespaces', publisherRoute(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    res.json({ namespaces: extensionPublisherStore.listOwned(identity.accountId) });
  }));

  router.post('/v1/extensions/publisher/namespaces', publisherRoute(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const namespace = extensionPublisherStore.create({
      namespace: req.body?.namespace,
      displayName: req.body?.displayName,
      ownerAccountId: identity.accountId,
    });
    res.status(201).json({ namespace });
  }));

  router.patch('/v1/extensions/publisher/namespaces/:namespace', publisherRoute(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const namespace = extensionPublisherStore.update({
      namespace: req.params.namespace,
      actorAccountId: identity.accountId,
      displayName: req.body?.displayName,
    });
    res.json({ namespace });
  }));

  router.post('/v1/extensions/publisher/namespaces/:namespace/transfer', publisherRoute(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const transfer = extensionPublisherStore.proposeTransfer({
      namespace: req.params.namespace,
      actorAccountId: identity.accountId,
      targetAccountId: req.body?.targetAccountId,
    });
    res.status(201).json({ transfer });
  }));

  router.post('/v1/extensions/publisher/namespaces/:namespace/transfer/accept', publisherRoute(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const namespace = extensionPublisherStore.acceptTransfer({
      namespace: req.params.namespace,
      actorAccountId: identity.accountId,
      transferId: req.body?.transferId,
    });
    res.json({ namespace });
  }));

  router.delete('/v1/extensions/publisher/namespaces/:namespace/transfer', publisherRoute(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const namespace = extensionPublisherStore.cancelTransfer({
      namespace: req.params.namespace,
      actorAccountId: identity.accountId,
    });
    res.json({ namespace });
  }));

  function artifactErrorStatus(error) {
    if (error instanceof ExtensionPublisherStoreError) return publisherErrorStatus(error);
    if (!(error instanceof ExtensionArtifactStoreError)) return 500;
    if (error.code === 'RELEASE_NOT_FOUND' || error.code === 'ARTIFACT_NOT_FOUND') return 404;
    if (error.code === 'REVIEW_AUTH_REQUIRED') return 403;
    if (error.code === 'ARTIFACT_BINDING_CONFLICT'
      || error.code === 'ARTIFACT_RELEASE_FROZEN'
      || error.code === 'SCAN_ALREADY_FINAL') return 409;
    return 400;
  }

  function artifactRoute(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        const status = artifactErrorStatus(error);
        res.status(status).json({
          success: false,
          error: {
            code: error?.code ?? 'EXTENSION_ARTIFACT_ERROR',
            message: status >= 500 ? 'Extension artifact operation failed' : String(error?.message ?? error),
          },
        });
      }
    };
  }

  router.post(
    '/v1/extensions/publisher/artifacts',
    express.raw({ type: 'application/octet-stream', limit: '25mb' }),
    artifactRoute(async (req, res) => {
      const identity = await identityFor(req, { accountRequired: true });
      const artifact = extensionArtifactStore.upload({
        actorAccountId: identity.accountId,
        kind: req.get('x-fabushi-extension-kind'),
        namespace: req.get('x-fabushi-extension-namespace'),
        name: req.get('x-fabushi-extension-name'),
        version: req.get('x-fabushi-extension-version'),
        artifactId: req.get('x-fabushi-artifact-id'),
        platform: req.get('x-fabushi-artifact-platform'),
        architecture: req.get('x-fabushi-artifact-architecture') || 'any',
        format: req.get('x-fabushi-artifact-format'),
        bytes: req.body,
      });
      res.status(201).json({ artifact });
    }),
  );

  router.post(
    '/v1/extensions/review/artifacts/:kind/:namespace/:name/:version/:artifactId/scan',
    artifactRoute(async (req, res) => {
      if (!reviewAuthorized(req)) {
        throw new ExtensionArtifactStoreError(
          'REVIEW_AUTH_REQUIRED',
          'marketplace reviewer authorization is required',
        );
      }
      const artifact = extensionArtifactStore.recordScan({
        reviewer: req.body?.reviewer ?? 'marketplace-reviewer',
        kind: req.params.kind,
        namespace: req.params.namespace,
        name: req.params.name,
        version: req.params.version,
        artifactId: req.params.artifactId,
        state: req.body?.state,
        scanner: req.body?.scanner,
        scannerVersion: req.body?.scannerVersion,
        notes: req.body?.notes,
      });
      res.json({ artifact });
    }),
  );

  router.get('/v1/extensions/artifacts/:digest', artifactRoute(async (req, res) => {
    const artifact = extensionArtifactStore.approvedArtifact(req.params.digest);
    if (!artifact) {
      throw new ExtensionArtifactStoreError('ARTIFACT_NOT_FOUND', 'approved artifact was not found');
    }
    res.set({
      'content-type': 'application/octet-stream',
      'content-length': String(artifact.sizeBytes),
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${artifact.digest}"`,
      'x-content-type-options': 'nosniff',
    });
    res.sendFile(artifact.path);
  }));

  function releaseErrorStatus(error) {
    if (error instanceof ExtensionPublisherStoreError) return publisherErrorStatus(error);
    if (error instanceof ExtensionArtifactStoreError) return artifactErrorStatus(error);
    if (error instanceof ExtensionSigningStoreError) {
      if (error.code === 'TRUST_KEY_NOT_FOUND') return 404;
      if (error.code === 'SIGNATURE_CONFLICT'
        || error.code === 'TRUST_KEY_ALREADY_REVOKED'
        || error.code === 'TRUST_KEY_MATERIAL_CONFLICT'
        || error.code === 'TRUST_KEY_REVOKED'
        || error.code === 'ACTIVE_SIGNER_REVOCATION_REQUIRES_ROTATION') return 409;
      if (error.code === 'SIGNING_KEY_REQUIRED') return 503;
      return 400;
    }
    if (!(error instanceof ExtensionReleaseStoreError)) return 500;
    if (error.code === 'RELEASE_NOT_FOUND') return 404;
    if (error.code === 'RELEASE_CONFLICT' || error.code === 'INVALID_RELEASE_STATE') return 409;
    if (error.code === 'REVIEW_AUTH_REQUIRED') return 403;
    return 400;
  }

  function releaseRoute(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (rawError) {
        const error = extensionReleaseErrorFromRegistry(rawError);
        const status = releaseErrorStatus(error);
        res.status(status).json({
          success: false,
          error: {
            code: error?.code ?? 'EXTENSION_RELEASE_ERROR',
            message: status >= 500 ? 'Extension release operation failed' : String(error?.message ?? error),
          },
        });
      }
    };
  }

  function releaseParams(req) {
    return {
      kind: req.params.kind,
      namespace: req.params.namespace,
      name: req.params.name,
      version: req.params.version,
    };
  }

  router.get('/v1/extensions/publisher/releases', releaseRoute(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    res.json({ releases: extensionReleaseStore.listPublisher(identity.accountId) });
  }));

  router.post('/v1/extensions/publisher/releases', releaseRoute(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const release = extensionReleaseStore.createDraft({
      actorAccountId: identity.accountId,
      descriptor: req.body?.descriptor ?? req.body,
    });
    res.status(201).json({ release });
  }));

  router.post('/v1/extensions/publisher/releases/:kind/:namespace/:name/:version/submit', releaseRoute(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const release = extensionReleaseStore.submit({
      actorAccountId: identity.accountId,
      ...releaseParams(req),
    });
    res.json({ release });
  }));

  router.post('/v1/extensions/publisher/releases/:kind/:namespace/:name/:version/yank', releaseRoute(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const release = extensionReleaseStore.yank({
      actorAccountId: identity.accountId,
      notes: req.body?.notes,
      ...releaseParams(req),
    });
    res.json({ release });
  }));

  router.post('/v1/extensions/review/releases/:kind/:namespace/:name/:version', releaseRoute(async (req, res) => {
    if (!reviewAuthorized(req)) {
      throw new ExtensionReleaseStoreError('REVIEW_AUTH_REQUIRED', 'marketplace reviewer authorization is required');
    }
    const release = extensionReleaseStore.review({
      approved: req.body?.approved === true,
      reviewer: req.body?.reviewer,
      notes: req.body?.notes,
      ...releaseParams(req),
    });
    res.json({ release });
  }));

  router.post('/v1/extensions/review/releases/:kind/:namespace/:name/:version/revoke', releaseRoute(async (req, res) => {
    if (!reviewAuthorized(req)) {
      throw new ExtensionReleaseStoreError('REVIEW_AUTH_REQUIRED', 'marketplace reviewer authorization is required');
    }
    const release = extensionReleaseStore.revoke({
      reviewer: req.body?.reviewer,
      notes: req.body?.notes,
      ...releaseParams(req),
    });
    res.json({ release });
  }));

  router.get('/v1/extensions/trust', releaseRoute(async (_req, res) => {
    res.json({ trust: extensionSigningStore.trustFeed() });
  }));

  router.post('/v1/extensions/review/trust/:keyId/:trustEpoch/revoke', releaseRoute(async (req, res) => {
    if (!reviewAuthorized(req)) {
      throw new ExtensionReleaseStoreError(
        'REVIEW_AUTH_REQUIRED',
        'marketplace reviewer authorization is required',
      );
    }
    const trust = extensionSigningStore.revokeTrustKey({
      keyId: req.params.keyId,
      trustEpoch: req.params.trustEpoch,
      reason: req.body?.reason,
    });
    res.json({ trust });
  }));

  router.get('/v1/extensions/trust/current', (_req, res) => {
    res.json({ trust: extensionSigningStore.currentTrust() });
  });

  router.get('/v1/extensions', extensionRoute(async (req, res) => {
    const payload = browseExtensions(marketplace, {
      query: safeQuery(req.query.q ?? req.query.query),
      kind: safeQuery(req.query.kind, 32) || undefined,
      platform: safeQuery(req.query.platform, 32) || undefined,
      origin: safeQuery(req.query.origin, 32) || undefined,
      limit: Number(req.query.limit ?? 50),
      cursor: safeQuery(req.query.cursor, 4096) || undefined,
    }, extensionReleaseStore);
    res.json(payload);
  }));

  router.get('/v1/extensions/:kind/:namespace/:name', extensionRoute(async (req, res) => {
    res.json({
      extension: readExtension(marketplace, {
        kind: req.params.kind,
        namespace: req.params.namespace,
        name: req.params.name,
      }, extensionReleaseStore),
    });
  }));

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

  // Grok-style Agent Store: Bot profile and Agent runtime state have separate
  // identities. Agent state is account-scoped, content-addressed and conflict
  // preserving; removing a Bot membership intentionally does not delete it.
  router.get('/v1/account/agents', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    res.json({ agents: syncStore.listAgents(identity.accountId), cursor: syncStore.currentCursor(identity.accountId) });
  }));

  router.get('/v1/account/agents/:agentId', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const agent = syncStore.getAgent(identity.accountId, req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: 'agent_not_found', agentId: req.params.agentId });
      return;
    }
    res.json(agent);
  }));

  router.put('/v1/account/agents/:agentId', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    res.json(syncStore.upsertAgent(identity.accountId, req.params.agentId, {
      profile: req.body?.profile ?? {},
      metadata: req.body?.metadata ?? {},
    }));
  }));

  router.get('/v1/account/agents/:agentId/store', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const relPath = safeQuery(req.query.path, 4096);
    if (!relPath) {
      const prefix = safeQuery(req.query.prefix, 4096);
      res.json({
        agentId: req.params.agentId,
        files: syncStore.listAgentObjects(identity.accountId, req.params.agentId, prefix),
      });
      return;
    }
    const object = syncStore.getAgentObject(identity.accountId, req.params.agentId, relPath);
    if (!object) {
      res.status(404).json({ error: 'agent_store_object_not_found', agentId: req.params.agentId, path: relPath });
      return;
    }
    res.json({
      ...object,
      data: undefined,
      dataBase64: object.data.toString('base64'),
    });
  }));

  router.put('/v1/account/agents/:agentId/store', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const relPath = safeQuery(req.body?.path, 4096);
    const dataBase64 = typeof req.body?.dataBase64 === 'string' ? req.body.dataBase64 : '';
    if (!relPath || !dataBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
      throw new MiniAppMarketplaceError('INVALID_AGENT_STORE_OBJECT', 'path and base64 data are required');
    }
    const data = Buffer.from(dataBase64, 'base64');
    const result = syncStore.putAgentObject(identity.accountId, req.params.agentId, relPath, data, {
      baseEtag: req.body?.baseEtag,
      expectAbsent: req.body?.expectAbsent === true,
    });
    res.status(result.outcome === 'conflict' ? 409 : 200).json(result);
  }));

  router.delete('/v1/account/agents/:agentId/store', route(async (req, res) => {
    const identity = await identityFor(req, { accountRequired: true });
    const relPath = safeQuery(req.query.path ?? req.body?.path, 4096);
    if (!relPath) throw new MiniAppMarketplaceError('INVALID_AGENT_STORE_OBJECT', 'path is required');
    res.json(syncStore.deleteAgentObject(identity.accountId, req.params.agentId, relPath, {
      baseEtag: safeQuery(req.query.baseEtag ?? req.body?.baseEtag, 256) || undefined,
    }));
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

  return { router, marketplace, accountSyncStore: syncStore, extensionPublisherStore, extensionReleaseStore, extensionArtifactStore, extensionSigningStore, globalDharmaRuntimeStore };
}

export function registerMiniAppMarketplaceRoutes(app, options = {}) {
  const registration = createMiniAppMarketplaceRouter(options);
  app.use(registration.router);
  return registration;
}
