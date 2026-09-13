import { MiniAppMarketplace, MiniAppMarketplaceError, MINIAPP_INSTALL_PROTOCOL, officialMiniAppManifests } from './miniapp_marketplace.js';
import { requireManifest } from './miniapp_marketplace_server_common.js';

export const MINIAPP_PACKAGE_COMMIT = 'cc23420c56c98f7857b731832281c212203ce60c';
export const MINIAPP_BOT_PROTOCOL = 'fabushi.miniapp.bot.v2';
export const CHROME_EXTENSION_PLATFORM = 'chrome-extension';
export const USER_SCRIPT_RUNTIME_FORM = 'userscript';

const RAW_PACKAGE_ROOT = `https://raw.githubusercontent.com/bhrumom/fabushi/${MINIAPP_PACKAGE_COMMIT}/marketplace/packages`;
const MARKETPLACE_PACKAGE_RELEASE_TAG = 'marketplace-v1.0.1-cc23420c56c9';
const MARKETPLACE_PACKAGE_RELEASE_ASSET_ROOT = `https://github.com/bhrumom/fabushi/releases/download/${MARKETPLACE_PACKAGE_RELEASE_TAG}`;
export const ALL_PLATFORMS = ['desktop', 'mobile', 'web', 'cli', 'ios', 'android', CHROME_EXTENSION_PLATFORM];
const USER_SCRIPT_ARCHIVE_FORMATS = new Set(['user-js', 'userscript']);


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
    plugin.runtimeForm,
    ...(plugin.categories ?? []),
    ...(plugin.tags ?? []),
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
      plugins: payload.plugins.filter((plugin) => {
        const manifest = this.get(plugin.pluginId);
        return matchesDiscovery({
          ...plugin,
          runtimeForm: marketplaceRuntimeForm(manifest),
          categories: manifest?.categories ?? [],
          tags: manifest?.tags ?? [],
        }, query);
      }).slice(0, requestedLimit),
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
    version: '1.0.1',
    sha256: 'ce5beae5f3b8a29dccb65cb91744f2a82bb19186c3f7031ca75f405ab4effb76',
    sizeBytes: 983,
    artifactUrl: `${MARKETPLACE_PACKAGE_RELEASE_ASSET_ROOT}/chatgpt-auto-confirm-1.0.1.tar.gz`,
  },
  'faliu-flashcards': {
    version: '1.0.1',
    sha256: 'fb2a8fa187fde312069c9facb49657c366cfa4176f27a90abff5aa407e260356',
    sizeBytes: 1729,
    artifactUrl: `${MARKETPLACE_PACKAGE_RELEASE_ASSET_ROOT}/faliu-flashcards-1.0.1.tar.gz`,
  },
  'global-dharma': {
    version: '1.0.0',
    sha256: '43de877dc87b5dff306164eb143baad545ef40bea2247f28cbe21616829478be',
    sizeBytes: 1827,
  },
  'douyin-batch-downloader': {
    version: '1.0.0',
    sha256: '6784eb6ade91ef75ff61717a232dd154c7a3fb28c093ce330bc7ca4857ace473',
    sizeBytes: 3069,
  },
  'hermes-installer': {
    version: '1.0.1',
    sha256: 'e693cb2378d580cb86d88fb391a04b8c96dcf6614b445c32339bfb7358e0c4cd',
    sizeBytes: 1731,
    artifactUrl: `${MARKETPLACE_PACKAGE_RELEASE_ASSET_ROOT}/hermes-installer-1.0.1.tar.gz`,
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
            url: artifact.artifactUrl
              ?? `${RAW_PACKAGE_ROOT}/${encodeURIComponent(manifest.id)}/${encodeURIComponent(manifest.version)}/app.tar.gz`,
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

function isUserScriptArtifact(artifact) {
  return USER_SCRIPT_ARCHIVE_FORMATS.has(String(artifact?.archiveFormat ?? artifact?.format ?? '').trim().toLocaleLowerCase());
}

export function marketplaceRuntimeForm(manifest) {
  return manifest?.distribution?.artifacts?.some(isUserScriptArtifact) ? USER_SCRIPT_RUNTIME_FORM : 'miniapp';
}

function manifestSupportsPlatform(manifest, platform) {
  if (!platform) return marketplaceRuntimeForm(manifest) !== USER_SCRIPT_RUNTIME_FORM;
  const runtimeForm = marketplaceRuntimeForm(manifest);
  if (runtimeForm === USER_SCRIPT_RUNTIME_FORM) {
    return platform === CHROME_EXTENSION_PLATFORM
      && manifest.surfaces.some((surface) => surface.platforms.includes(CHROME_EXTENSION_PLATFORM) || surface.platforms.includes('all'));
  }
  if (platform === CHROME_EXTENSION_PLATFORM) {
    return manifest.surfaces.some((surface) => surface.platforms.includes(CHROME_EXTENSION_PLATFORM)
      || surface.platforms.includes('web')
      || surface.platforms.includes('all'));
  }
  return manifest.surfaces.some((surface) => surface.platforms.includes(platform) || surface.platforms.includes('all'));
}

function runtimeArtifact(artifact, runtimeForm) {
  return {
    id: artifact.id,
    runtime: runtimeForm === USER_SCRIPT_RUNTIME_FORM ? USER_SCRIPT_RUNTIME_FORM : 'local-web',
    platforms: artifactPlatforms(artifact),
    source: { type: 'https', url: artifact.url },
    sha256: artifact.sha256,
    size: artifact.sizeBytes,
    format: artifact.archiveFormat,
    entry: runtimeForm === USER_SCRIPT_RUNTIME_FORM ? 'script.user.js' : 'index.html',
  };
}

function installContract(manifest, artifacts, runtimeForm) {
  const resolvedArtifacts = artifacts.map((artifact) => artifact.source
    ? artifact
    : runtimeArtifact(artifact, runtimeForm));
  return {
    protocol: MINIAPP_INSTALL_PROTOCOL,
    strategy: 'github-immutable',
    pluginId: manifest.id,
    version: manifest.version,
    source: {
      repository: manifest.distribution.repository,
      sourceRef: manifest.distribution.sourceRef,
      manifestUrl: manifest.distribution.manifestUrl,
      marketplaceHostsPackage: false,
    },
    artifacts: resolvedArtifacts,
    update: {
      check: 'marketplace-release',
      comparison: 'version-then-artifact-sha256',
      allowDowngrade: false,
      rollback: 'previous-active',
    },
    permissions: manifest.permissions,
  };
}

export function marketplaceReleaseResponse(manifest, platform = 'desktop') {
  if (!manifest || manifest.review?.state !== 'approved') {
    throw new MiniAppMarketplaceError('RELEASE_NOT_APPROVED', 'mini app release is not approved');
  }
  if (platform && !ALL_PLATFORMS.includes(platform)) {
    throw new MiniAppMarketplaceError('INVALID_PLATFORM', `unsupported platform ${platform}`);
  }
  const runtimeForm = marketplaceRuntimeForm(manifest);
  if (!manifestSupportsPlatform(manifest, platform)) {
    throw new MiniAppMarketplaceError('PLATFORM_INCOMPATIBLE', `${manifest.id} is not available on ${platform || 'this platform'}`);
  }
  const artifacts = manifest.distribution.artifacts
    .filter((artifact) => artifact.platform === 'all' || !platform || artifact.platform === platform)
    .map((artifact) => runtimeArtifact(artifact, runtimeForm));
  if (manifest.distribution.installMode === 'package' && artifacts.length === 0) {
    throw new MiniAppMarketplaceError('NO_COMPATIBLE_ARTIFACT', `no ${platform} artifact is available`);
  }
  const install = installContract(manifest, artifacts, runtimeForm);
  return {
    pluginId: manifest.id,
    version: manifest.version,
    runtimeForm,
    releaseStatus: manifest.review.state,
    install,
    releaseManifest: {
      schemaVersion: 1,
      protocol: 'mahayana.external-release.v1',
      pluginId: manifest.id,
      version: manifest.version,
      runtimeForm,
      permissions: manifest.permissions,
      artifacts,
      install,
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
  const requestedPlatform = String(options.platform ?? '').trim().toLocaleLowerCase() || undefined;
  const storePlatform = requestedPlatform === CHROME_EXTENSION_PLATFORM ? undefined : requestedPlatform;
  const payload = store.browse({ ...options, platform: storePlatform });
  return {
    ...payload,
    plugins: payload.plugins.flatMap((plugin) => {
      const manifest = requireManifest(store, plugin.pluginId);
      if (!manifestSupportsPlatform(manifest, requestedPlatform)) return [];
      const release = marketplaceReleaseResponse(manifest, requestedPlatform || 'desktop');
      return [{
        ...plugin,
        runtimeForm: release.runtimeForm,
        categories: manifest.categories,
        tags: manifest.tags,
        releaseManifest: release.releaseManifest,
        install: release.install,
        source: { ...plugin.source, ...release.source },
        bot: manifest.bot,
        surfaces: manifest.surfaces,
        commands: release.commands,
        installMode: manifest.distribution.installMode,
        ...(baseUrl
          ? { botEndpoint: `${baseUrl}/api/mcp/miniapp-bot/${encodeURIComponent(manifest.id)}` }
          : {}),
      }];
    }),
  };
}
