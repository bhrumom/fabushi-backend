import { MiniAppMarketplace, MiniAppMarketplaceError, officialMiniAppManifests } from './miniapp_marketplace.js';
import { requireManifest } from './miniapp_marketplace_server_common.js';

export const MINIAPP_PACKAGE_COMMIT = 'a76587178c6b63be7963f14deb550e00bb0a425e';
export const MINIAPP_BOT_PROTOCOL = 'fabushi.miniapp.bot.v2';

const RAW_PACKAGE_ROOT = `https://raw.githubusercontent.com/bhrumom/fabushi/${MINIAPP_PACKAGE_COMMIT}/marketplace/packages`;
export const ALL_PLATFORMS = ['desktop', 'mobile', 'web', 'cli', 'ios', 'android'];


// Compatibility guard for the original v2 domain ranker: popularity is a
// ranking signal, never a search match. Keep discovery filtering at the
// catalog boundary so REST, MCP and direct marketplace consumers share the
// same behavior while the persistent store remains backward compatible.
const SEARCH_GUARD = Symbol.for('fabushi.miniapp.marketplace.search-guard.v2');

function normalizedDiscoveryText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ');
}

function discoveryDocument(plugin) {
  return normalizedDiscoveryText([
    plugin.pluginId,
    plugin.displayName,
    plugin.description,
    plugin.latestVersion,
    plugin.source?.publisher?.id,
    plugin.source?.publisher?.displayName,
    plugin.source?.repository,
    plugin.source?.bot?.id,
    plugin.source?.bot?.username,
    plugin.source?.bot?.displayName,
    ...(plugin.platforms ?? []),
    ...(plugin.source?.surfaces ?? []).flatMap((surface) => [
      surface.id,
      surface.kind,
      surface.title,
      surface.command,
      surface.server,
      ...(surface.platforms ?? []),
      ...(surface.capabilities ?? []),
    ]),
    ...(plugin.source?.commands ?? []).flatMap((command) => [
      command.name,
      command.description,
      command.usage,
      command.tool,
      ...(command.aliases ?? []),
      ...(command.naturalLanguageHints ?? []),
    ]),
  ].filter(Boolean).join(' '));
}

function matchesDiscovery(plugin, query) {
  const normalized = normalizedDiscoveryText(query);
  if (!normalized) return true;
  const document = discoveryDocument(plugin);
  if (document.includes(normalized)) return true;
  const tokens = normalized.split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => document.includes(token));
}

if (!MiniAppMarketplace.prototype[SEARCH_GUARD]) {
  const originalBrowse = MiniAppMarketplace.prototype.browse;
  Object.defineProperty(MiniAppMarketplace.prototype, SEARCH_GUARD, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  MiniAppMarketplace.prototype.browse = function browseWithDiscoveryGuard(options = {}) {
    const query = normalizedDiscoveryText(options.query);
    if (!query) return originalBrowse.call(this, options);
    const requestedLimit = Math.max(1, Math.min(200, Number(options.limit) || 50));
    const payload = originalBrowse.call(this, { ...options, limit: 200 });
    return {
      ...payload,
      plugins: payload.plugins.filter((plugin) => matchesDiscovery(plugin, query)).slice(0, requestedLimit),
    };
  };
}

const packageCatalog = {
  'bot-father': {
    version: '1.0.0',
    sha256: '8439c9c7ffe03791177bb5b9cbfd425ffb794b741d9e17c9cc2cadc09fbb7880',
    sizeBytes: 1805,
  },
  'chatgpt-auto-confirm': {
    version: '1.0.0+codex.20260810093000',
    sha256: 'c668cb932b534499e31fb6ffeee72687a03e8348c4fb0865ca1887602db68c2f',
    sizeBytes: 1822,
  },
  'faliu-flashcards': {
    version: '1.0.0',
    sha256: '7383d21f888b07045810a6dca515098e4dcdaae8d96b79be5401f2b96fdc40f5',
    sizeBytes: 1738,
  },
  'global-dharma': {
    version: '1.0.0',
    sha256: '43de877dc87b5dff306164eb143baad545ef40bea2247f28cbe21616829478be',
    sizeBytes: 1827,
  },
  'hermes-installer': {
    version: '1.0.0',
    sha256: '95adcdb83440ed143874c402c222856de89dc5bfd7ec910dbeece089d88aeec4',
    sizeBytes: 1741,
  },
  'mahayana-assistant': {
    version: '1.0.0',
    sha256: 'e175196bd10827d7e22cec1aa56bcb15540b03ce17c8cb84a7beac8719434d7b',
    sizeBytes: 1777,
  },
  'platform-publish': {
    version: '1.0.0',
    sha256: '4ded6de4cada43998f5fae2f226c4bea50b3fbc62a609f13c87a2102efb10802',
    sizeBytes: 1742,
  },
};

export function officialMiniAppPackageSeeds() {
  return officialMiniAppManifests().map((manifest) => {
    const artifact = packageCatalog[manifest.id];
    if (!artifact || artifact.version !== manifest.version) return manifest;
    return {
      ...manifest,
      distribution: {
        ...manifest.distribution,
        installMode: 'package',
        sourceRef: MINIAPP_PACKAGE_COMMIT,
        artifacts: [
          {
            id: `${manifest.id}-universal-ui`,
            platform: 'all',
            architecture: 'any',
            archiveFormat: 'tar-gz',
            url: `${RAW_PACKAGE_ROOT}/${encodeURIComponent(manifest.id)}/${encodeURIComponent(manifest.version)}/app.tar.gz`,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
          },
        ],
      },
    };
  });
}

function artifactPlatforms(artifact) {
  return artifact.platform === 'all' ? [...ALL_PLATFORMS] : [artifact.platform];
}

function runtimeArtifact(artifact) {
  return {
    id: artifact.id,
    runtime: 'local-web',
    platforms: artifactPlatforms(artifact),
    source: { type: 'https', url: artifact.url },
    sha256: artifact.sha256,
    size: artifact.sizeBytes,
    format: artifact.archiveFormat,
    entry: 'index.html',
  };
}

export function marketplaceReleaseResponse(manifest, platform = 'desktop') {
  if (!manifest || manifest.review?.state !== 'approved') {
    throw new MiniAppMarketplaceError('RELEASE_NOT_APPROVED', 'mini app release is not approved');
  }
  if (platform && !ALL_PLATFORMS.includes(platform)) {
    throw new MiniAppMarketplaceError('INVALID_PLATFORM', `unsupported platform ${platform}`);
  }
  const artifacts = manifest.distribution.artifacts
    .filter((artifact) => artifact.platform === 'all' || !platform || artifact.platform === platform)
    .map(runtimeArtifact);
  if (manifest.distribution.installMode === 'package' && artifacts.length === 0) {
    throw new MiniAppMarketplaceError('NO_COMPATIBLE_ARTIFACT', `no ${platform} artifact is available`);
  }
  return {
    pluginId: manifest.id,
    version: manifest.version,
    releaseStatus: manifest.review.state,
    releaseManifest: {
      schemaVersion: 1,
      protocol: 'mahayana.external-release.v1',
      pluginId: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      artifacts,
    },
    source: {
      protocol: manifest.protocol,
      repository: manifest.distribution.repository,
      sourceRef: manifest.distribution.sourceRef,
      manifestUrl: manifest.distribution.manifestUrl,
      marketplaceHostsPackage: false,
      digest: manifest.digest,
    },
    installMode: manifest.distribution.installMode,
    bot: manifest.bot,
    surfaces: manifest.surfaces,
    commands: manifest.commands.map((command) => ({
      ...command,
      slash: `/${manifest.id}:${command.name}`,
    })),
    uiUrl: `/v1/marketplace/miniapps/${encodeURIComponent(manifest.id)}/ui`,
  };
}

export function browseMarketplace(store, options = {}, baseUrl = '') {
  const payload = store.browse(options);
  return {
    ...payload,
    plugins: payload.plugins.map((plugin) => {
      const manifest = requireManifest(store, plugin.pluginId);
      const release = marketplaceReleaseResponse(manifest, options.platform || 'desktop');
      return {
        ...plugin,
        releaseManifest: release.releaseManifest,
        source: { ...plugin.source, ...release.source },
        bot: manifest.bot,
        surfaces: manifest.surfaces,
        commands: release.commands,
        installMode: manifest.distribution.installMode,
        ...(baseUrl
          ? { botEndpoint: `${baseUrl}/api/mcp/miniapp-bot/${encodeURIComponent(manifest.id)}` }
          : {}),
      };
    }),
  };
}

