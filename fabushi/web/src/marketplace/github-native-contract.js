const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_BRANCH = /^[^\s~^:?*\[\\]+$/;
const VALID_VISIBILITY = new Set(['public', 'private', 'internal']);
const VALID_KINDS = new Set(['common', 'native-cli', 'web-wasm']);
const VALID_OSES = new Set(['macos', 'windows', 'linux']);
const VALID_ARCHES = new Set(['arm64', 'x64']);
const VALID_WEB_TARGETS = new Set(['ios', 'android', 'desktop-webview', 'web', 'pwa']);

export const MCP_APPS_STABLE_VERSION = '2026-01-26';
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';
export const MCP_APPS_MIME = 'text/html;profile=mcp-app';

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function requiredString(value, field, maxLength = 512) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength) {
    fail('manifest_invalid', `${field} is required`, { field });
  }
  return normalized;
}

function exactSha(value, pattern, field) {
  const normalized = requiredString(value, field).toLowerCase();
  if (!pattern.test(normalized)) {
    fail('manifest_invalid', `${field} must be an exact hexadecimal digest`, { field });
  }
  return normalized;
}

function httpsUrl(value, field) {
  let url;
  try {
    url = new URL(requiredString(value, field));
  } catch {
    fail('manifest_invalid', `${field} must be a valid URL`, { field });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    fail('manifest_invalid', `${field} must be an HTTPS URL without credentials or fragment`, { field });
  }
  return url.toString();
}

function safeSubdirectory(value) {
  const normalized = String(value ?? '.').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.') return '.';
  if (normalized.startsWith('/') || normalized.endsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('source_invalid', 'source.subdirectory must be a repository-relative directory');
  }
  return normalized;
}

function sortedUniqueStrings(value, field, allowed = null) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('manifest_invalid', `${field} must be a non-empty array`, { field });
  }
  const normalized = [...new Set(value.map((item) => requiredString(item, field, 128)))].sort();
  if (allowed && normalized.some((item) => !allowed.has(item))) {
    fail('manifest_invalid', `${field} contains an unsupported value`, { field, values: normalized });
  }
  return normalized;
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(stableObject(value));
}

export function normalizeGitHubSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('source_invalid', 'source must be an object');
  }
  const provider = requiredString(value.provider, 'source.provider').toLowerCase();
  if (provider !== 'github') fail('source_invalid', 'source.provider must be github');
  const repository = requiredString(value.repository, 'source.repository', 200);
  if (!REPOSITORY.test(repository)) fail('source_invalid', 'source.repository must be owner/name');
  const repositoryId = Number(value.repositoryId);
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    fail('source_invalid', 'source.repositoryId must be a positive GitHub repository ID');
  }
  const defaultBranch = requiredString(value.defaultBranch, 'source.defaultBranch', 255);
  if (!SAFE_BRANCH.test(defaultBranch)) fail('source_invalid', 'source.defaultBranch is invalid');
  const visibility = requiredString(value.visibility ?? 'public', 'source.visibility').toLowerCase();
  if (!VALID_VISIBILITY.has(visibility)) fail('source_invalid', 'source.visibility is invalid');
  const licenseSpdx = requiredString(value.licenseSpdx ?? value.license, 'source.licenseSpdx', 64);
  if (licenseSpdx === 'NOASSERTION' || licenseSpdx === 'NONE') {
    fail('license_required', 'a formal public release requires an explicit SPDX license');
  }
  return {
    provider,
    repositoryId,
    repository,
    defaultBranch,
    commit: exactSha(value.commit, SHA1, 'source.commit'),
    treeHash: exactSha(value.treeHash, SHA1, 'source.treeHash'),
    licenseSpdx,
    visibility,
    subdirectory: safeSubdirectory(value.subdirectory),
  };
}

function normalizeArtifact(value, sourceCommit) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('artifact_invalid', 'artifact must be an object');
  }
  const kind = requiredString(value.kind, 'artifact.kind').toLowerCase();
  if (!VALID_KINDS.has(kind)) fail('artifact_invalid', `unsupported artifact kind: ${kind}`);
  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 * 1024 * 1024) {
    fail('artifact_invalid', 'artifact.size must be a positive integer below 2 GiB');
  }
  const artifact = {
    id: requiredString(value.id, 'artifact.id', 160),
    kind,
    sourceCommit: exactSha(value.sourceCommit, SHA1, 'artifact.sourceCommit'),
    url: httpsUrl(value.url, 'artifact.url'),
    sha256: exactSha(value.sha256, SHA256, 'artifact.sha256'),
    size,
    mediaType: requiredString(value.mediaType, 'artifact.mediaType', 128),
    sbomUrl: httpsUrl(value.sbomUrl, 'artifact.sbomUrl'),
    attestationUrl: httpsUrl(value.attestationUrl, 'artifact.attestationUrl'),
    minHostVersion: requiredString(value.minHostVersion, 'artifact.minHostVersion', 64),
    requiredCapabilities: Array.isArray(value.requiredCapabilities)
      ? [...new Set(value.requiredCapabilities.map((item) => requiredString(item, 'artifact.requiredCapabilities', 128)))].sort()
      : [],
  };
  if (artifact.sourceCommit !== sourceCommit) {
    fail('source_commit_mismatch', 'every artifact must bind the exact release source commit', {
      artifactId: artifact.id,
      expected: sourceCommit,
      actual: artifact.sourceCommit,
    });
  }
  if (kind === 'common') {
    artifact.platform = 'all';
  } else if (kind === 'native-cli') {
    const os = requiredString(value.os, 'artifact.os').toLowerCase();
    const architecture = requiredString(value.architecture, 'artifact.architecture').toLowerCase();
    if (!VALID_OSES.has(os) || !VALID_ARCHES.has(architecture)) {
      fail('artifact_invalid', 'native-cli requires a supported os and architecture');
    }
    artifact.os = os;
    artifact.architecture = architecture;
  } else {
    artifact.webTargets = sortedUniqueStrings(value.webTargets, 'artifact.webTargets', VALID_WEB_TARGETS);
    artifact.wasmFeatures = Array.isArray(value.wasmFeatures)
      ? [...new Set(value.wasmFeatures.map((item) => requiredString(item, 'artifact.wasmFeatures', 128)))].sort()
      : [];
  }
  return artifact;
}

function artifactSelector(artifact) {
  if (artifact.kind === 'common') return 'common';
  if (artifact.kind === 'native-cli') return `native-cli:${artifact.os}:${artifact.architecture}`;
  return `web-wasm:${artifact.webTargets.join(',')}`;
}

function normalizeToolContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('tool_contract_invalid', 'toolContract must be an object');
  }
  const tools = sortedUniqueStrings(value.tools, 'toolContract.tools');
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    sha256: exactSha(value.sha256, SHA256, 'toolContract.sha256'),
    tools,
    errorCodes: Array.isArray(value.errorCodes)
      ? [...new Set(value.errorCodes.map((item) => requiredString(item, 'toolContract.errorCodes', 128)))].sort()
      : [],
  };
}

function normalizeMcpApps(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('mcp_apps_required', 'mcpApps must be an object');
  }
  const specification = requiredString(value.specification, 'mcpApps.specification');
  const extension = requiredString(value.extension, 'mcpApps.extension');
  const mimeType = requiredString(value.mimeType, 'mcpApps.mimeType');
  if (specification !== MCP_APPS_STABLE_VERSION || extension !== MCP_APPS_EXTENSION || mimeType !== MCP_APPS_MIME) {
    fail('mcp_apps_required', 'release must use MCP Apps stable 2026-01-26');
  }
  const resources = sortedUniqueStrings(value.resources, 'mcpApps.resources');
  if (resources.some((resource) => !resource.startsWith('ui://'))) {
    fail('ui_resource_invalid', 'all MCP Apps resources must use ui://');
  }
  return {
    specification,
    extension,
    mimeType,
    resources,
    displayModes: sortedUniqueStrings(value.displayModes ?? ['inline'], 'mcpApps.displayModes'),
    cspSha256: exactSha(value.cspSha256, SHA256, 'mcpApps.cspSha256'),
  };
}

function normalizeDerivation(value, pluginId, source) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail('derivation_invalid', 'derivation must be an object');
  }
  const upstreamPluginId = requiredString(value.upstreamPluginId, 'derivation.upstreamPluginId', 128);
  if (!SAFE_ID.test(upstreamPluginId)) fail('derivation_invalid', 'upstreamPluginId is invalid');
  if (upstreamPluginId === pluginId) {
    fail('derived_plugin_id_reuse', 'a derived app must use a different plugin ID');
  }
  const upstreamRepository = requiredString(value.upstreamRepository, 'derivation.upstreamRepository', 200);
  if (!REPOSITORY.test(upstreamRepository) || upstreamRepository === source.repository) {
    fail('derivation_invalid', 'derived source must identify a distinct fork repository');
  }
  const upstreamCommit = exactSha(value.upstreamCommit, SHA1, 'derivation.upstreamCommit');
  const syncBaseCommit = exactSha(value.syncBaseCommit ?? value.upstreamCommit, SHA1, 'derivation.syncBaseCommit');
  return {
    upstreamPluginId,
    upstreamRepository,
    upstreamCommit,
    syncBaseCommit,
    permissionDiffSha256: exactSha(value.permissionDiffSha256, SHA256, 'derivation.permissionDiffSha256'),
    toolContractDiffSha256: exactSha(value.toolContractDiffSha256, SHA256, 'derivation.toolContractDiffSha256'),
    artifactDiffSha256: exactSha(value.artifactDiffSha256, SHA256, 'derivation.artifactDiffSha256'),
    trademarkNotice: requiredString(value.trademarkNotice, 'derivation.trademarkNotice', 512),
  };
}

export function normalizeReleaseManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('manifest_invalid', 'release manifest must be an object');
  }
  const pluginId = requiredString(value.pluginId, 'pluginId', 128);
  if (!SAFE_ID.test(pluginId)) fail('manifest_invalid', 'pluginId is invalid');
  const version = requiredString(value.version, 'version', 64);
  if (!SAFE_VERSION.test(version)) fail('manifest_invalid', 'version must be semantic versioning');
  const source = normalizeGitHubSource(value.source);
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 2) {
    fail('artifact_invalid', 'release requires common plus at least one executable artifact');
  }
  const artifacts = value.artifacts.map((artifact) => normalizeArtifact(artifact, source.commit));
  const selectors = artifacts.map(artifactSelector);
  if (new Set(selectors).size !== selectors.length) {
    fail('artifact_selector_ambiguous', 'artifact platform selectors must not overlap', { selectors });
  }
  if (artifacts.filter((artifact) => artifact.kind === 'common').length !== 1) {
    fail('artifact_invalid', 'release requires exactly one common artifact');
  }
  if (!artifacts.some((artifact) => artifact.kind === 'native-cli' || artifact.kind === 'web-wasm')) {
    fail('artifact_invalid', 'release requires native-cli or web-wasm');
  }
  const manifest = {
    schemaVersion: 3,
    protocol: 'mahayana.mcp-app-release.v3',
    pluginId,
    version,
    source,
    toolContract: normalizeToolContract(value.toolContract),
    mcpApps: normalizeMcpApps(value.mcpApps),
    permissionsSha256: exactSha(value.permissionsSha256, SHA256, 'permissionsSha256'),
    parentManifestSha256: exactSha(value.parentManifestSha256, SHA256, 'parentManifestSha256'),
    artifacts: artifacts.sort((left, right) => left.id.localeCompare(right.id)),
    derivation: normalizeDerivation(value.derivation, pluginId, source),
  };
  return manifest;
}

export function validateUntrustedPullRequestWorkflow(workflowText) {
  const text = String(workflowText ?? '');
  const failures = [];
  if (!/(?:^|\n)on:\s*(?:\n\s+)?pull_request\s*:/m.test(text) && !/(?:^|\n)on:\s*\[?\s*pull_request/m.test(text)) {
    failures.push('workflow must run on pull_request');
  }
  if (/pull_request_target\s*:/m.test(text)) failures.push('pull_request_target is forbidden for untrusted code');
  if (/secrets\s*\.|\$\{\{\s*secrets\./m.test(text)) failures.push('fork PR workflow must not read secrets');
  if (/id-token\s*:\s*write/m.test(text)) failures.push('fork PR workflow must not mint OIDC tokens');
  if (/contents\s*:\s*write/m.test(text)) failures.push('fork PR workflow must use read-only contents permission');
  if (!/permissions\s*:\s*\n(?:\s+[^\n]+\n)*?\s+contents\s*:\s*read/m.test(text)) {
    failures.push('workflow must explicitly set contents: read');
  }
  if (/gh\s+release\s+create|npm\s+publish|wrangler\s+deploy|actions\/attest|upload-artifact@/m.test(text)) {
    failures.push('untrusted workflow must not publish, deploy, attest, or export reusable artifacts');
  }
  return { valid: failures.length === 0, failures };
}

export function validateTrustedReleaseWorkflow(workflowText) {
  const text = String(workflowText ?? '');
  const failures = [];
  if (/pull_request(?:_target)?\s*:/m.test(text)) failures.push('trusted release workflow must not execute on pull requests');
  if (!/id-token\s*:\s*write/m.test(text)) failures.push('trusted release workflow requires id-token: write');
  if (!/attestations\s*:\s*write/m.test(text)) failures.push('trusted release workflow requires attestations: write');
  if (!/SOURCE_COMMIT\s*:\s*\$\{\{\s*github\.sha\s*\}\}/m.test(text)) failures.push('workflow must bind SOURCE_COMMIT to github.sha');
  if (!/actions\/attest-build-provenance@/m.test(text)) failures.push('workflow must create GitHub artifact attestations');
  if (!/release\s*:\s*\n\s+types\s*:\s*\[published\]/m.test(text) && !/tags\s*:/m.test(text)) {
    failures.push('workflow must be protected release or tag triggered');
  }
  return { valid: failures.length === 0, failures };
}
