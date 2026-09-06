import crypto from 'node:crypto';
import process from 'node:process';

import { MiniAppMarketplaceError, renderMiniAppHomeDocument } from './miniapp_marketplace.js';
const MINIAPP_BOT_PROTOCOL = 'fabushi.miniapp.bot.v2';

const APP_MIME = 'text/html;profile=mcp-app';

function bearerToken(req) {
  const header = String(req.get?.('authorization') ?? req.headers?.authorization ?? '').trim();
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
}

export function requestIdentity(req) {
  const token = bearerToken(req);
  const device = String(req.get?.('x-fabushi-device-id') ?? req.headers?.['x-fabushi-device-id'] ?? '').trim();
  const forwarded = String(req.get?.('x-forwarded-for') ?? req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
  const remote = String(req.ip ?? req.socket?.remoteAddress ?? forwarded ?? 'anonymous');
  const agent = String(req.get?.('user-agent') ?? req.headers?.['user-agent'] ?? 'unknown');
  const material = token ? `token:${token}` : device ? `device:${device}` : `anonymous:${remote}:${agent}`;
  const digest = crypto.createHash('sha256').update(material).digest('hex');
  return {
    scopeId: `scope-${digest}`,
    publisherId: `publisher-${digest.slice(0, 24)}`,
    authenticated: Boolean(token),
  };
}

export function safeQuery(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

export function requireManifest(store, id, options = {}) {
  const manifest = store.get(id, options);
  if (!manifest) throw new MiniAppMarketplaceError('NOT_FOUND', `mini app ${id} was not found`);
  return manifest;
}

export function publisherForRequest(req, body = {}) {
  const identity = requestIdentity(req);
  const supplied = body.publisher && typeof body.publisher === 'object' ? body.publisher : {};
  return {
    id: identity.publisherId,
    displayName: String(supplied.displayName ?? supplied.name ?? body.publisherName ?? 'Fabushi Publisher').trim().slice(0, 120),
    website: supplied.website,
    verified: false,
  };
}

export function publicBaseUrl(req) {
  const configured = String(process.env.FABUSHI_PUBLIC_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const forwardedProtocol = String(req.get?.('x-forwarded-proto') ?? '').split(',')[0].trim();
  const protocol = forwardedProtocol || req.protocol || 'https';
  const host = String(req.get?.('host') ?? 'api.ombhrum.com');
  return `${protocol}://${host}`;
}

export function commandDispatch(manifest, command, args = {}) {
  const surface = manifest.surfaces.find((candidate) => candidate.id === command.surfaceId);
  if (!surface) throw new MiniAppMarketplaceError('INVALID_MANIFEST', `surface ${command.surfaceId} is missing`);
  return {
    protocol: MINIAPP_BOT_PROTOCOL,
    miniAppId: manifest.id,
    bot: manifest.bot,
    command: {
      ...command,
      slash: `/${manifest.id}:${command.name}`,
    },
    arguments: args && typeof args === 'object' ? args : { input: String(args ?? '') },
    surface,
    approval: command.approval,
    requiresApproval: command.approval !== 'none',
    execution: {
      kind: surface.kind,
      endpoint: surface.url,
      command: surface.command,
      server: surface.server,
      tool: command.tool,
    },
  };
}

function errorStatus(error) {
  const explicitStatus = Number(error?.statusCode);
  if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) {
    return explicitStatus;
  }
  const mapping = {
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    REVIEW_AUTH_REQUIRED: 403,
    INVALID_STATE: 409,
    RELEASE_NOT_APPROVED: 409,
    NO_COMPATIBLE_ARTIFACT: 409,
    STORE_CORRUPT: 500,
  };
  return mapping[error?.code] ?? (error instanceof MiniAppMarketplaceError ? 400 : 500);
}

export function sendError(res, error) {
  if (res.headersSent) return;
  const status = errorStatus(error);
  res.status(status).json({
    success: false,
    error: {
      code: error?.code ?? 'MINIAPP_MARKETPLACE_ERROR',
      message: status >= 500 ? 'Mini App marketplace operation failed' : String(error?.message ?? error),
    },
  });
}

export function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

export function reviewAuthorized(req) {
  const configured = String(process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN ?? '').trim();
  if (configured.length < 32) return false;
  const supplied = String(req.get?.('x-fabushi-marketplace-review-token') ?? bearerToken(req)).trim();
  if (supplied.length !== configured.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(configured));
}

export function result(text, structuredContent = {}) {
  return { content: [{ type: 'text', text }], structuredContent };
}

export function annotations({ readOnly = false, destructive = false, openWorld = false } = {}) {
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    openWorldHint: openWorld,
  };
}

function miniAppUiResourceUri(id) {
  return `ui://fabushi/miniapp/${id}/home-v2.html`;
}

export function registerMiniAppResource(server, manifest) {
  const uri = miniAppUiResourceUri(manifest.id);
  server.registerResource(
    `miniapp-${manifest.id}-home`,
    uri,
    {
      title: `${manifest.title} Mini App`,
      description: manifest.description,
      mimeType: APP_MIME,
    },
    async () => ({
      contents: [{ uri, mimeType: APP_MIME, text: renderMiniAppHomeDocument(manifest) }],
    }),
  );
  return uri;
}

