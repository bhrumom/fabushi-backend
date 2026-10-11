import { officialMcpApps } from './official_mcp_apps.js';

export const EXTENSION_REGISTRY_PROTOCOL = 'fabushi.extension-registry.v1';
export const EXTENSION_MANIFEST_SCHEMA_VERSION = 1;

const KINDS = new Set(['mcp-connector', 'skill', 'web-miniapp']);
const ORIGINS = new Set(['public', 'team', 'private-created']);
const TRUST_DOMAINS = new Set(['catalog-authorized', 'team-authorized', 'private-local-author']);
const CHANNELS = new Set(['stable', 'preview']);
const PLATFORMS = new Set(['desktop', 'ios', 'android', 'web', 'cli', 'mobile', 'chrome-extension']);
const SAFE_COMPONENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SECRET_FIELD = /(token|secret|password|api[-_]?key|credential|authorization)/i;

export class ExtensionRegistryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ExtensionRegistryError';
    this.code = code;
    this.details = details;
  }
}

function requiredComponent(value, field) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase();
  if (!SAFE_COMPONENT.test(normalized)) {
    throw new ExtensionRegistryError('INVALID_EXTENSION_IDENTITY', `${field} is invalid`, { field });
  }
  return normalized;
}

function requiredEnum(value, field, allowed) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase();
  if (!allowed.has(normalized)) {
    throw new ExtensionRegistryError('INVALID_EXTENSION_FILTER', `${field} is invalid`, { field, value });
  }
  return normalized;
}

function normalizedPlatforms(values) {
  const result = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const platform = String(raw ?? '').trim().toLocaleLowerCase();
    if (!platform) continue;
    if (platform === 'all') {
      for (const supported of PLATFORMS) result.add(supported);
      continue;
    }
    if (platform === 'mobile') {
      result.add('mobile');
      result.add('ios');
      result.add('android');
      continue;
    }
    if (PLATFORMS.has(platform)) result.add(platform);
  }
  return [...result].sort();
}

function stableIdentity(identity) {
  const namespace = requiredComponent(identity?.namespace, 'identity.namespace');
  const name = requiredComponent(identity?.name, 'identity.name');
  const kind = requiredEnum(identity?.kind, 'identity.kind', KINDS);
  return {
    namespace,
    name,
    kind,
    id: `${namespace}/${name}:${kind}`,
  };
}

function assertSafePublicObject(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafePublicObject(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) {
      throw new ExtensionRegistryError(
        'REGISTRY_SECRET_FIELD',
        `public extension metadata contains forbidden field ${path}.${key}`,
      );
    }
    assertSafePublicObject(child, `${path}.${key}`);
  }
}

export function normalizeExtensionEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExtensionRegistryError('INVALID_EXTENSION_ENTRY', 'extension entry must be an object');
  }
  const identity = stableIdentity(value.identity);
  const origin = requiredEnum(value.origin, 'origin', ORIGINS);
  const trustDomain = requiredEnum(value.trustDomain, 'trustDomain', TRUST_DOMAINS);
  const channel = requiredEnum(value.release?.channel ?? 'stable', 'release.channel', CHANNELS);
  const version = String(value.release?.version ?? '').trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ExtensionRegistryError('INVALID_EXTENSION_VERSION', 'release.version must use semantic versioning');
  }
  const platforms = normalizedPlatforms(value.release?.platforms);
  if (platforms.length === 0) {
    throw new ExtensionRegistryError('INVALID_EXTENSION_PLATFORM', 'release.platforms must contain a supported platform');
  }
  const requestedCapabilities = [...new Set(
    (Array.isArray(value.release?.requestedCapabilities) ? value.release.requestedCapabilities : [])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean),
  )].sort();
  const entry = {
    schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
    protocol: EXTENSION_REGISTRY_PROTOCOL,
    id: identity.id,
    identity: {
      namespace: identity.namespace,
      name: identity.name,
      kind: identity.kind,
    },
    origin,
    trustDomain,
    displayName: String(value.displayName ?? identity.name).trim().slice(0, 160),
    description: String(value.description ?? '').trim().slice(0, 1000),
    publisher: {
      id: requiredComponent(value.publisher?.id ?? identity.namespace, 'publisher.id'),
      displayName: String(value.publisher?.displayName ?? value.publisher?.id ?? identity.namespace).trim().slice(0, 160),
      verified: value.publisher?.verified === true,
      verificationEvidence: Array.isArray(value.publisher?.verificationEvidence)
        ? value.publisher.verificationEvidence.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
        : [],
    },
    release: {
      version,
      channel,
      platforms,
      requestedCapabilities,
      revoked: value.release?.revoked === true,
      ...(Number.isInteger(value.release?.minHostApi) && value.release.minHostApi > 0
        ? { minHostApi: value.release.minHostApi }
        : {}),
      ...(value.release?.manifestDigest ? { manifestDigest: String(value.release.manifestDigest) } : {}),
      ...(value.release?.bundleDigest ? { bundleDigest: String(value.release.bundleDigest) } : {}),
    },
    categories: [...new Set((Array.isArray(value.categories) ? value.categories : [])
      .map((item) => String(item).trim().toLocaleLowerCase()).filter(Boolean))].sort(),
    tags: [...new Set((Array.isArray(value.tags) ? value.tags : [])
      .map((item) => String(item).trim().toLocaleLowerCase()).filter(Boolean))].sort(),
    compatibility: {
      platforms,
    },
    legacy: {
      ...(value.legacy && typeof value.legacy === 'object' ? value.legacy : {}),
    },
    runtime: {
      ...(value.runtime && typeof value.runtime === 'object' ? value.runtime : {}),
    },
  };
  assertSafePublicObject(entry);
  return entry;
}

function miniAppPlatforms(manifest) {
  return normalizedPlatforms((manifest.surfaces ?? []).flatMap((surface) => surface.platforms ?? []));
}

export function projectMiniAppExtension(manifest) {
  if (!manifest || manifest.review?.state !== 'approved') {
    throw new ExtensionRegistryError('EXTENSION_NOT_PUBLISHED', 'mini app must be approved before public projection');
  }
  const publisherId = requiredComponent(manifest.publisher?.id ?? 'unknown-publisher', 'publisher.id');
  return normalizeExtensionEntry({
    identity: {
      namespace: publisherId,
      name: manifest.id,
      kind: 'web-miniapp',
    },
    origin: 'public',
    trustDomain: 'catalog-authorized',
    displayName: manifest.title,
    description: manifest.description,
    publisher: {
      id: publisherId,
      displayName: manifest.publisher?.displayName ?? publisherId,
      // Legacy MiniApp manifests carry a boolean, but the unified Registry does not
      // upgrade that claim into a verified Fabushi publisher without separate evidence.
      verified: false,
      verificationEvidence: [],
    },
    release: {
      version: manifest.version,
      channel: 'stable',
      platforms: miniAppPlatforms(manifest),
      requestedCapabilities: manifest.permissions ?? [],
      manifestDigest: manifest.digest,
      revoked: manifest.review?.state === 'yanked',
    },
    categories: manifest.categories ?? [],
    tags: manifest.tags ?? [],
    legacy: {
      pluginId: manifest.id,
      protocol: manifest.protocol,
    },
    runtime: {
      owner: 'miniapp-marketplace',
      installMode: manifest.distribution?.installMode,
      surfaces: (manifest.surfaces ?? []).map((surface) => ({
        id: surface.id,
        kind: surface.kind,
        platforms: normalizedPlatforms(surface.platforms),
      })),
    },
  });
}

export function projectOfficialMcpExtension(app) {
  return normalizeExtensionEntry({
    identity: {
      namespace: 'fabushi',
      name: app.id,
      kind: 'mcp-connector',
    },
    origin: 'public',
    trustDomain: 'catalog-authorized',
    displayName: app.title,
    description: app.description,
    publisher: {
      id: 'fabushi',
      displayName: 'Fabushi',
      verified: false,
      verificationEvidence: [],
    },
    release: {
      version: app.version,
      channel: 'stable',
      platforms: normalizedPlatforms(app.platforms),
      requestedCapabilities: [],
    },
    categories: ['productivity'],
    tags: ['mcp'],
    legacy: {
      pluginId: app.pluginId,
      serverId: app.mcpServer,
    },
    runtime: {
      owner: 'official-mcp-apps',
      transport: 'streamable-http',
      endpoint: app.endpoint,
    },
  });
}

function allExtensionEntries(marketplace) {
  const miniApps = marketplace.list().map(projectMiniAppExtension);
  const mcp = officialMcpApps.map(projectOfficialMcpExtension);
  return [...miniApps, ...mcp].sort((left, right) => left.id.localeCompare(right.id));
}

function encodeCursor(id) {
  return Buffer.from(JSON.stringify({ v: 1, after: id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new ExtensionRegistryError('INVALID_EXTENSION_CURSOR', 'cursor is invalid');
  }
  if (parsed?.v !== 1 || typeof parsed.after !== 'string' || !parsed.after) {
    throw new ExtensionRegistryError('INVALID_EXTENSION_CURSOR', 'cursor is invalid');
  }
  return parsed.after;
}

function queryDocument(entry) {
  return [
    entry.id,
    entry.identity.namespace,
    entry.identity.name,
    entry.identity.kind,
    entry.displayName,
    entry.description,
    entry.publisher.id,
    entry.publisher.displayName,
    ...entry.categories,
    ...entry.tags,
  ].join(' ').normalize('NFKC').toLocaleLowerCase();
}

export function browseExtensions(marketplace, options = {}) {
  const query = String(options.query ?? '').normalize('NFKC').trim().toLocaleLowerCase();
  const kind = options.kind ? requiredEnum(options.kind, 'kind', KINDS) : null;
  const origin = options.origin ? requiredEnum(options.origin, 'origin', ORIGINS) : null;
  const platform = options.platform ? requiredEnum(options.platform, 'platform', PLATFORMS) : null;
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
  let entries = allExtensionEntries(marketplace)
    .filter((entry) => !kind || entry.identity.kind === kind)
    .filter((entry) => !origin || entry.origin === origin)
    .filter((entry) => !platform || entry.release.platforms.includes(platform))
    .filter((entry) => !query || queryDocument(entry).includes(query));

  const after = decodeCursor(options.cursor);
  if (after) {
    const index = entries.findIndex((entry) => entry.id === after);
    if (index < 0) {
      throw new ExtensionRegistryError('STALE_EXTENSION_CURSOR', 'cursor no longer matches the filtered catalog');
    }
    entries = entries.slice(index + 1);
  }

  const page = entries.slice(0, limit);
  const hasMore = entries.length > page.length;
  return {
    protocol: EXTENSION_REGISTRY_PROTOCOL,
    schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
    entries: page,
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1].id) : null,
  };
}

export function readExtension(marketplace, { kind, namespace, name } = {}) {
  const identity = stableIdentity({ kind, namespace, name });
  const entry = allExtensionEntries(marketplace).find((candidate) => candidate.id === identity.id);
  if (!entry) {
    throw new ExtensionRegistryError('EXTENSION_NOT_FOUND', `extension ${identity.id} was not found`);
  }
  return entry;
}
