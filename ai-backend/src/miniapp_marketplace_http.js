import path from 'node:path';
import process from 'node:process';

import express from 'express';

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
  publisherForRequest,
  requestIdentity,
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

export function createMiniAppMarketplaceRouter({ dataDir, storagePath, store } = {}) {
  const marketplace = store ?? new MiniAppMarketplace({
    storagePath: storagePath ?? path.join(dataDir ?? process.cwd(), 'miniapps', 'marketplace-v2.json'),
    seed: officialMiniAppPackageSeeds(),
  });
  const router = express.Router();
  router.use(express.json({ limit: MAX_JSON_BYTES }));

  router.get('/v1/marketplace/plugins', route(async (req, res) => {
    const identity = requestIdentity(req);
    const payload = browseMarketplace(marketplace, {
      query: safeQuery(req.query.q ?? req.query.query),
      platform: safeQuery(req.query.platform, 32) || undefined,
      scopeId: identity.scopeId,
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
    const identity = requestIdentity(req);
    const added = marketplace.add(req.params.pluginId, identity.scopeId);
    res.status(201).json({
      ...added,
      release: marketplaceReleaseResponse(added.miniApp, safeQuery(req.body?.platform, 32) || 'desktop'),
      botEndpoint: `${publicBaseUrl(req)}/api/mcp/miniapp-bot/${encodeURIComponent(added.miniApp.id)}`,
    });
  }));

  router.delete('/v1/marketplace/plugins/:pluginId/add', route(async (req, res) => {
    const identity = requestIdentity(req);
    res.json(marketplace.remove(req.params.pluginId, identity.scopeId));
  }));

  router.get('/v1/marketplace/added', route(async (req, res) => {
    const identity = requestIdentity(req);
    res.json({ protocol: MINIAPP_MARKETPLACE_PROTOCOL, apps: marketplace.added(identity.scopeId) });
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
    const publisher = publisherForRequest(req, req.body ?? {});
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
      if (req.body?.submitForReview === true) {
        draft = marketplace.submit(draft.id, publisher.id);
      }
    }
    res.status(201).json({ workflow, draft });
  }));

  router.post('/v1/marketplace/publisher/drafts', route(async (req, res) => {
    const publisher = publisherForRequest(req, req.body ?? {});
    const draft = marketplace.createDraft({ ...req.body, publisher });
    res.status(201).json({ miniApp: draft });
  }));

  router.post('/v1/marketplace/publisher/:pluginId/submit', route(async (req, res) => {
    const identity = requestIdentity(req);
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
    const identity = requestIdentity(req);
    res.json({ miniApp: marketplace.yank(req.params.pluginId, identity.publisherId, req.body?.notes) });
  }));

  router.get('/v1/marketplace/miniapps/:pluginId/ui', route(async (req, res) => {
    const manifest = requireManifest(marketplace, req.params.pluginId);
    res.type('html').set('Cache-Control', 'public, max-age=300').send(renderMiniAppHomeDocument(manifest));
  }));

  router.all('/api/mcp/miniapp-marketplace', route(async (req, res) => {
    const identity = requestIdentity(req);
    const baseUrl = publicBaseUrl(req);
    await handleMcpRequest({
      endpoint: 'miniapp-marketplace',
      req,
      res,
      scopeId: identity.scopeId,
      createServer: () => createMarketplaceMcpServer(marketplace, identity.scopeId, baseUrl),
    });
  }));

  router.all('/api/mcp/miniapp-bot/:pluginId', route(async (req, res) => {
    const identity = requestIdentity(req);
    const id = req.params.pluginId;
    const baseUrl = publicBaseUrl(req);
    requireManifest(marketplace, id);
    await handleMcpRequest({
      endpoint: `miniapp-bot:${id}`,
      req,
      res,
      scopeId: identity.scopeId,
      createServer: () => createMiniAppBotMcpServer(marketplace, identity.scopeId, id, baseUrl),
    });
  }));

  return { router, marketplace };
}

export function registerMiniAppMarketplaceRoutes(app, options = {}) {
  const registration = createMiniAppMarketplaceRouter(options);
  app.use(registration.router);
  return registration;
}
