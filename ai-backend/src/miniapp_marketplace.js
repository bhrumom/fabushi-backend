import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeMiniAppBotCalls } from './miniapp_call_program.js';
import { globalDharmaMarketplaceCommands } from './global_dharma_tool_contract.js';

export const MINIAPP_MARKETPLACE_PROTOCOL = 'fabushi.miniapp.marketplace.v2';
export const MINIAPP_MANIFEST_PROTOCOL = 'fabushi.miniapp.manifest.v2';
export const MINIAPP_RELEASE_PROTOCOL = 'mahayana.external-release.v1';
export const MINIAPP_GENERATION_PROTOCOL = 'mahayana.miniapp.generation.v1';

const REVIEW_STATES = new Set(['draft', 'validating', 'pending_review', 'approved', 'rejected', 'yanked']);
const SURFACE_KINDS = new Set(['web', 'mcp-http', 'mcp-stdio', 'cli', 'wasm', 'native']);
const APPROVAL_MODES = new Set(['none', 'required', 'destructive']);
const INSTALL_MODES = new Set(['metadata', 'package']);
const DEFAULT_STORAGE_PATH = path.join(os.homedir(), '.fabushi', 'miniapp-marketplace-v2.json');
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const clone = (value) => JSON.parse(JSON.stringify(value));

function requiredText(value, field, max = 500) {
  const text = String(value ?? '').trim();
  if (!text) throw new MiniAppMarketplaceError('INVALID_MANIFEST', `${field} is required`);
  if (text.length > max) throw new MiniAppMarketplaceError('INVALID_MANIFEST', `${field} exceeds ${max} characters`);
  return text;
}

function optionalText(value, max = 500) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (text.length > max) throw new MiniAppMarketplaceError('INVALID_MANIFEST', `value exceeds ${max} characters`);
  return text;
}

function normalizedUrl(value, field, { allowRelative = false } = {}) {
  const text = requiredText(value, field, 2048);
  if (allowRelative && text.startsWith('/')) return text;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `${field} must be a valid URL`);
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `${field} must use http or https`);
  }
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `${field} must use https outside localhost`);
  }
  return parsed.toString();
}

function normalizedStringArray(value, field, maxItems = 32) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MiniAppMarketplaceError('INVALID_MANIFEST', `${field} must be an array`);
  if (value.length > maxItems) throw new MiniAppMarketplaceError('INVALID_MANIFEST', `${field} has too many items`);
  return [...new Set(value.map((item) => requiredText(item, field, 80).toLocaleLowerCase()))];
}

function normalizedPublisher(value) {
  const publisher = value && typeof value === 'object' ? value : {};
  const id = requiredText(publisher.id, 'publisher.id', 64).toLocaleLowerCase();
  if (!ID_PATTERN.test(id)) throw new MiniAppMarketplaceError('INVALID_MANIFEST', 'publisher.id is invalid');
  return {
    id,
    displayName: requiredText(publisher.displayName ?? publisher.name ?? id, 'publisher.displayName', 120),
    verified: Boolean(publisher.verified),
    website: publisher.website ? normalizedUrl(publisher.website, 'publisher.website') : undefined,
  };
}

function normalizedBot(value, manifest, surfaces, commands) {
  const bot = value && typeof value === 'object' ? value : {};
  const id = String(bot.id ?? `${manifest.id}-bot`).trim().toLocaleLowerCase();
  if (!ID_PATTERN.test(id)) throw new MiniAppMarketplaceError('INVALID_MANIFEST', 'bot.id is invalid');
  const username = String(bot.username ?? `${manifest.id.replaceAll('-', '_')}_bot`).trim().toLocaleLowerCase();
  if (!/^[a-z0-9_]{3,64}$/.test(username)) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', 'bot.username is invalid');
  }
  let calls;
  try {
    calls = normalizeMiniAppBotCalls(bot.calls, surfaces, commands);
  } catch (error) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', error instanceof Error ? error.message : String(error));
  }
  return {
    id,
    username,
    displayName: requiredText(bot.displayName ?? manifest.title, 'bot.displayName', 120),
    description: optionalText(bot.description ?? manifest.description, 500),
    conversationId: requiredText(bot.conversationId ?? `miniapp:${manifest.id}`, 'bot.conversationId', 160),
    managedBy: requiredText(bot.managedBy ?? 'bot-father', 'bot.managedBy', 64),
    mainApp: bot.mainApp !== false,
    naturalLanguage: bot.naturalLanguage !== false,
    menuButton: {
      text: requiredText(bot.menuButton?.text ?? '打开小程序', 'bot.menuButton.text', 64),
      action: 'open-miniapp',
      miniAppId: manifest.id,
    },
    calls,
  };
}

function normalizedSurface(value, index) {
  if (!value || typeof value !== 'object') {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `surfaces[${index}] must be an object`);
  }
  const kind = requiredText(value.kind, `surfaces[${index}].kind`, 32).toLocaleLowerCase();
  if (!SURFACE_KINDS.has(kind)) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `unsupported surface kind ${kind}`);
  }
  const surface = {
    id: requiredText(value.id ?? `${kind}-${index + 1}`, `surfaces[${index}].id`, 64),
    kind,
    title: optionalText(value.title, 120),
    platforms: normalizedStringArray(value.platforms ?? ['desktop', 'mobile', 'web', 'cli'], `surfaces[${index}].platforms`, 8),
    priority: Number.isFinite(Number(value.priority)) ? Number(value.priority) : 0,
    local: Boolean(value.local),
  };
  if (value.url) surface.url = normalizedUrl(value.url, `surfaces[${index}].url`, { allowRelative: true });
  if (value.command) surface.command = requiredText(value.command, `surfaces[${index}].command`, 1024);
  if (value.server) surface.server = requiredText(value.server, `surfaces[${index}].server`, 160);
  if (value.entry) surface.entry = requiredText(value.entry, `surfaces[${index}].entry`, 1024);
  if (kind === 'web' && !surface.url && !surface.entry) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `web surface ${surface.id} requires url or entry`);
  }
  if (kind === 'mcp-http' && !surface.url) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `mcp-http surface ${surface.id} requires url`);
  }
  if (['mcp-stdio', 'cli', 'native'].includes(kind) && !surface.command && !surface.entry) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `${kind} surface ${surface.id} requires command or entry`);
  }
  return surface;
}

function normalizedCommand(value, index, surfaces) {
  if (!value || typeof value !== 'object') {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `commands[${index}] must be an object`);
  }
  const name = requiredText(value.name, `commands[${index}].name`, 64).toLocaleLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `commands[${index}].name is invalid`);
  }
  const surfaceId = requiredText(value.surfaceId ?? surfaces[0]?.id, `commands[${index}].surfaceId`, 64);
  if (!surfaces.some((surface) => surface.id === surfaceId)) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `commands[${index}] references unknown surface ${surfaceId}`);
  }
  const approval = requiredText(value.approval ?? 'none', `commands[${index}].approval`, 32).toLocaleLowerCase();
  if (!APPROVAL_MODES.has(approval)) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `commands[${index}].approval is invalid`);
  }
  return {
    name,
    aliases: normalizedStringArray(value.aliases, `commands[${index}].aliases`, 12),
    description: requiredText(value.description ?? name, `commands[${index}].description`, 240),
    usage: optionalText(value.usage, 240),
    surfaceId,
    tool: requiredText(value.tool ?? name, `commands[${index}].tool`, 120),
    approval,
    naturalLanguageHints: normalizedStringArray(value.naturalLanguageHints, `commands[${index}].naturalLanguageHints`, 16),
  };
}

function normalizedArtifact(value, index) {
  if (!value || typeof value !== 'object') {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `distribution.artifacts[${index}] must be an object`);
  }
  const sha256 = requiredText(value.sha256, `distribution.artifacts[${index}].sha256`, 64).toLocaleLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', `distribution.artifacts[${index}].sha256 is invalid`);
  }
  return {
    id: requiredText(value.id ?? `artifact-${index + 1}`, `distribution.artifacts[${index}].id`, 120),
    platform: requiredText(value.platform, `distribution.artifacts[${index}].platform`, 64).toLocaleLowerCase(),
    architecture: optionalText(value.architecture, 64)?.toLocaleLowerCase(),
    archiveFormat: requiredText(value.archiveFormat ?? 'zip', `distribution.artifacts[${index}].archiveFormat`, 32),
    url: normalizedUrl(value.url, `distribution.artifacts[${index}].url`),
    sha256,
    sizeBytes: Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0 ? value.sizeBytes : undefined,
    signatureUrl: value.signatureUrl ? normalizedUrl(value.signatureUrl, `distribution.artifacts[${index}].signatureUrl`) : undefined,
  };
}

function normalizedDistribution(value, surfaces) {
  const distribution = value && typeof value === 'object' ? value : {};
  const installMode = requiredText(distribution.installMode ?? 'metadata', 'distribution.installMode', 32).toLocaleLowerCase();
  if (!INSTALL_MODES.has(installMode)) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', 'distribution.installMode is invalid');
  }
  const repository = normalizedUrl(
    distribution.repository ?? 'https://github.com/bhrumom/fabushi',
    'distribution.repository',
  );
  const manifestUrl = distribution.manifestUrl
    ? normalizedUrl(distribution.manifestUrl, 'distribution.manifestUrl')
    : undefined;
  const artifacts = Array.isArray(distribution.artifacts)
    ? distribution.artifacts.map(normalizedArtifact)
    : [];
  if (installMode === 'package' && artifacts.length === 0) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', 'package installs require at least one external artifact');
  }
  if (installMode === 'metadata' && !surfaces.some((surface) => ['web', 'mcp-http'].includes(surface.kind))) {
    throw new MiniAppMarketplaceError(
      'INVALID_MANIFEST',
      'metadata installs require a web or remote MCP surface; local runtimes must use external package artifacts',
    );
  }
  return {
    installMode,
    repository,
    manifestUrl,
    sourceRef: optionalText(distribution.sourceRef, 160),
    license: optionalText(distribution.license, 80),
    artifacts,
    marketplaceHostsPackage: false,
  };
}

function normalizedReview(value, { allowDraft = false } = {}) {
  const review = value && typeof value === 'object' ? value : {};
  const state = requiredText(review.state ?? (allowDraft ? 'draft' : 'pending_review'), 'review.state', 32).toLocaleLowerCase();
  if (!REVIEW_STATES.has(state)) throw new MiniAppMarketplaceError('INVALID_MANIFEST', 'review.state is invalid');
  return {
    state,
    submittedAt: Number.isFinite(Number(review.submittedAt)) ? Number(review.submittedAt) : undefined,
    reviewedAt: Number.isFinite(Number(review.reviewedAt)) ? Number(review.reviewedAt) : undefined,
    reviewer: optionalText(review.reviewer, 120),
    notes: optionalText(review.notes, 1000),
  };
}

export function normalizeMiniAppManifest(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MiniAppMarketplaceError('INVALID_MANIFEST', 'manifest must be an object');
  }
  const id = requiredText(value.id, 'id', 64).toLocaleLowerCase();
  if (!ID_PATTERN.test(id)) throw new MiniAppMarketplaceError('INVALID_MANIFEST', 'id is invalid');
  const version = requiredText(value.version ?? '0.1.0', 'version', 64);
  if (!VERSION_PATTERN.test(version)) throw new MiniAppMarketplaceError('INVALID_MANIFEST', 'version is invalid');
  const base = {
    protocol: MINIAPP_MANIFEST_PROTOCOL,
    id,
    version,
    title: requiredText(value.title ?? id, 'title', 120),
    description: requiredText(value.description, 'description', 500),
    publisher: normalizedPublisher(value.publisher),
    categories: normalizedStringArray(value.categories ?? ['utilities'], 'categories', 8),
    tags: normalizedStringArray(value.tags, 'tags', 32),
    locales: normalizedStringArray(value.locales ?? ['zh-cn', 'en'], 'locales', 12),
    icon: value.icon ? normalizedUrl(value.icon, 'icon') : undefined,
    homepage: value.homepage ? normalizedUrl(value.homepage, 'homepage') : undefined,
    featured: Boolean(value.featured),
  };
  const surfaceInput = Array.isArray(value.surfaces) ? value.surfaces : [];
  if (surfaceInput.length === 0) throw new MiniAppMarketplaceError('INVALID_MANIFEST', 'at least one surface is required');
  const surfaces = surfaceInput.map(normalizedSurface);
  const commandInput = Array.isArray(value.commands) ? value.commands : [];
  const commands = commandInput.map((command, index) => normalizedCommand(command, index, surfaces));
  const manifest = {
    ...base,
    bot: normalizedBot(value.bot, base, surfaces, commands),
    surfaces,
    commands,
    distribution: normalizedDistribution(value.distribution, surfaces),
    permissions: normalizedStringArray(value.permissions, 'permissions', 32),
    review: normalizedReview(value.review, options),
    stats: {
      installs: Number.isSafeInteger(value.stats?.installs) && value.stats.installs >= 0 ? value.stats.installs : 0,
      monthlyActiveUsers: Number.isSafeInteger(value.stats?.monthlyActiveUsers) && value.stats.monthlyActiveUsers >= 0
        ? value.stats.monthlyActiveUsers
        : 0,
    },
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
  };
  manifest.digest = crypto.createHash('sha256').update(canonicalJson({ ...manifest, digest: undefined })).digest('hex');
  return manifest;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function searchText(manifest) {
  return [
    manifest.id,
    manifest.title,
    manifest.description,
    manifest.publisher.id,
    manifest.publisher.displayName,
    manifest.bot.id,
    manifest.bot.username,
    ...manifest.categories,
    ...manifest.tags,
    ...manifest.commands.flatMap((command) => [command.name, command.description, ...command.aliases, ...command.naturalLanguageHints]),
  ].join(' ').toLocaleLowerCase();
}

function searchScore(manifest, query) {
  const normalized = String(query ?? '').trim().toLocaleLowerCase();
  let score = manifest.featured ? 20 : 0;
  score += Math.min(25, Math.log10(1 + manifest.stats.monthlyActiveUsers) * 10);
  if (!normalized) return score;
  if (manifest.id === normalized || manifest.bot.username === normalized) score += 200;
  if (manifest.title.toLocaleLowerCase() === normalized) score += 180;
  if (manifest.title.toLocaleLowerCase().includes(normalized)) score += 100;
  if (manifest.tags.some((tag) => tag === normalized)) score += 80;
  if (searchText(manifest).includes(normalized)) score += 40;
  for (const token of normalized.split(/\s+/).filter(Boolean)) {
    if (searchText(manifest).includes(token)) score += 12;
  }
  return score;
}

function officialManifest(input) {
  return normalizeMiniAppManifest({
    publisher: {
      id: 'fabushi-official',
      displayName: 'Fabushi 官方',
      verified: true,
      website: 'https://fabushi.ombhrum.com',
    },
    locales: ['zh-cn', 'en'],
    featured: true,
    review: { state: 'approved', reviewer: 'fabushi-release-policy', reviewedAt: 1 },
    distribution: {
      installMode: 'metadata',
      repository: 'https://github.com/bhrumom/fabushi',
      sourceRef: 'main',
      license: 'repository-license',
    },
    ...input,
  });
}

const officialSeeds = [
  officialManifest({
    id: 'global-dharma',
    version: '1.0.0',
    title: '全球法布施',
    description: '同时提供图形界面、自然语言、MCP 与 CLI 的全平台法布施小程序。',
    categories: ['official', 'buddhism', 'automation'],
    tags: ['全球法布施', 'mcp', 'cli', '本地运行', '多端'],
    homepage: 'https://fabushi.ombhrum.com/miniapps/global-dharma/',
    bot: {
      id: 'global-dharma-bot',
      username: 'global_dharma_bot',
      displayName: '全球法布施',
      description: '用自然语言或 / 命令驱动全球发送、本地转经轮与场能模式。',
    },
    surfaces: [
      { id: 'remote-mcp', kind: 'mcp-http', title: '在线 MCP', url: 'https://api.ombhrum.com/api/mcp/apps/global-dharma', platforms: ['desktop', 'mobile', 'web', 'cli'], priority: 100 },
      { id: 'local-cli', kind: 'cli', title: '本地 CLI', command: 'mahayana miniapp run global-dharma', platforms: ['desktop', 'cli'], local: true, priority: 90 },
      { id: 'web-ui', kind: 'web', title: '图形界面', url: 'https://fabushi.ombhrum.com/miniapps/global-dharma/', platforms: ['desktop', 'mobile', 'web'], priority: 80 },
    ],
    commands: globalDharmaMarketplaceCommands(),
    permissions: ['network', 'local-execution'],
    stats: { monthlyActiveUsers: 1000 },
  }),
  officialManifest({
    id: 'faliu-flashcards',
    version: '1.0.0',
    title: '法流记忆卡',
    description: '通过自然语言、MCP 命令和图形界面创建、打开与复习法流记忆卡。',
    categories: ['official', 'education', 'buddhism'],
    tags: ['记忆卡', 'mcp', '学习'],
    homepage: 'https://fabushi.ombhrum.com/miniapps/faliu-flashcards/',
    surfaces: [
      { id: 'remote-mcp', kind: 'mcp-http', url: 'https://api.ombhrum.com/api/mcp/apps/faliu-flashcards', platforms: ['desktop', 'mobile', 'web', 'cli'], priority: 100 },
      { id: 'web-ui', kind: 'web', url: 'https://fabushi.ombhrum.com/miniapps/faliu-flashcards/', platforms: ['desktop', 'mobile', 'web'], priority: 80 },
    ],
    commands: [
      { name: 'list_decks', description: '列出记忆卡牌组', surfaceId: 'remote-mcp', tool: 'list_decks', aliases: ['牌组'] },
      { name: 'create_deck', description: '创建牌组', surfaceId: 'remote-mcp', tool: 'create_deck', approval: 'required' },
      { name: 'add_cards', description: '向牌组添加卡片', surfaceId: 'remote-mcp', tool: 'add_cards', approval: 'required' },
      { name: 'review', description: '开始复习', surfaceId: 'remote-mcp', tool: 'review' },
    ],
    permissions: ['account-storage'],
    stats: { monthlyActiveUsers: 600 },
  }),
  officialManifest({
    id: 'platform-publish',
    version: '1.0.0',
    title: '平台发布',
    description: '用自然语言创建草稿、预览并在明确批准后跨平台发布。',
    categories: ['official', 'productivity'],
    tags: ['发布', '草稿', 'mcp'],
    homepage: 'https://fabushi.ombhrum.com/miniapps/platform-publish/',
    surfaces: [
      { id: 'remote-mcp', kind: 'mcp-http', url: 'https://api.ombhrum.com/api/mcp/apps/platform-publish', platforms: ['desktop', 'mobile', 'web', 'cli'], priority: 100 },
      { id: 'web-ui', kind: 'web', url: 'https://fabushi.ombhrum.com/miniapps/platform-publish/', platforms: ['desktop', 'mobile', 'web'], priority: 80 },
    ],
    commands: [
      { name: 'draft', description: '创建发布草稿', surfaceId: 'remote-mcp', tool: 'draft', approval: 'required' },
      { name: 'preview', description: '预览草稿', surfaceId: 'remote-mcp', tool: 'preview' },
      { name: 'publish', description: '批准后发布', surfaceId: 'remote-mcp', tool: 'publish', approval: 'destructive' },
      { name: 'status', description: '查看发布状态', surfaceId: 'remote-mcp', tool: 'status' },
    ],
    permissions: ['network', 'publish-content'],
    stats: { monthlyActiveUsers: 450 },
  }),
  officialManifest({
    id: 'hermes-installer',
    version: '1.0.0',
    title: 'Hermes 安装器',
    description: '安全检查、安装和运行 Hermes，密钥只进入 Secret Store。',
    categories: ['official', 'developer-tools'],
    tags: ['hermes', '安装', '本地'],
    homepage: 'https://fabushi.ombhrum.com/miniapps/hermes-installer/',
    surfaces: [
      { id: 'remote-mcp', kind: 'mcp-http', url: 'https://api.ombhrum.com/api/mcp/apps/hermes-installer', platforms: ['desktop', 'cli'], priority: 100 },
      { id: 'web-ui', kind: 'web', url: 'https://fabushi.ombhrum.com/miniapps/hermes-installer/', platforms: ['desktop', 'web'], priority: 80 },
    ],
    commands: [
      { name: 'status', description: '检查安装与运行状态', surfaceId: 'remote-mcp', tool: 'status' },
      { name: 'install', description: '安装 Hermes', surfaceId: 'remote-mcp', tool: 'install', approval: 'destructive' },
      { name: 'start', description: '启动 Hermes', surfaceId: 'remote-mcp', tool: 'start', approval: 'required' },
      { name: 'stop', description: '停止 Hermes', surfaceId: 'remote-mcp', tool: 'stop', approval: 'required' },
    ],
    permissions: ['local-execution', 'secret-store', 'network'],
    stats: { monthlyActiveUsers: 350 },
  }),
  officialManifest({
    id: 'bot-father',
    version: '1.0.0',
    title: '机器人之父',
    description: '接入 Mahayana 多步骤能力，生成、验证、构建、提交审核并上线小程序。',
    categories: ['official', 'developer-tools'],
    tags: ['botfather', '生成小程序', '上架', 'mahayana'],
    homepage: 'https://fabushi.ombhrum.com/miniapps/bot-father/',
    bot: { id: 'bot-father-bot', username: 'bot_father', displayName: '机器人之父', managedBy: 'fabushi' },
    surfaces: [
      { id: 'remote-mcp', kind: 'mcp-http', url: 'https://api.ombhrum.com/api/mcp/apps/bot-father', platforms: ['desktop', 'mobile', 'web', 'cli'], priority: 100 },
      { id: 'web-ui', kind: 'web', url: 'https://fabushi.ombhrum.com/miniapps/bot-father/', platforms: ['desktop', 'mobile', 'web'], priority: 80 },
    ],
    commands: [
      { name: 'create_plugin', description: '创建小程序工程', surfaceId: 'remote-mcp', tool: 'create_plugin', approval: 'required' },
      { name: 'validate_plugin', description: '验证清单和工程', surfaceId: 'remote-mcp', tool: 'validate_plugin' },
      { name: 'build_plugin', description: '构建外部分发包', surfaceId: 'remote-mcp', tool: 'build_plugin', approval: 'required' },
      { name: 'generate_and_submit', description: '生成 Mahayana 多步骤任务并提交市场审核', surfaceId: 'remote-mcp', tool: 'generate_and_submit_miniapp', approval: 'required' },
      { name: 'market_search', description: '搜索市场', surfaceId: 'remote-mcp', tool: 'market_search' },
    ],
    permissions: ['workspace-write', 'network', 'github'],
    stats: { monthlyActiveUsers: 900 },
  }),
  officialManifest({
    id: 'mahayana-assistant',
    version: '1.0.0',
    title: '大乘助手',
    description: '搜索小程序市场、诊断插件并通过自然语言驱动已添加的小程序。',
    categories: ['official', 'assistant'],
    tags: ['mahayana', '助手', '市场搜索'],
    homepage: 'https://fabushi.ombhrum.com/miniapps/mahayana-assistant/',
    surfaces: [
      { id: 'remote-mcp', kind: 'mcp-http', url: 'https://api.ombhrum.com/api/mcp/apps/mahayana-assistant', platforms: ['desktop', 'mobile', 'web', 'cli'], priority: 100 },
      { id: 'web-ui', kind: 'web', url: 'https://fabushi.ombhrum.com/miniapps/mahayana-assistant/', platforms: ['desktop', 'mobile', 'web'], priority: 80 },
    ],
    commands: [
      { name: 'market_search', description: '搜索小程序市场', surfaceId: 'remote-mcp', tool: 'market_search', aliases: ['搜索小程序'] },
      { name: 'app_commands', description: '查看小程序 / 命令', surfaceId: 'remote-mcp', tool: 'app_commands' },
      { name: 'route_app_input', description: '把自然语言或 / 命令路由给小程序', surfaceId: 'remote-mcp', tool: 'route_app_input', approval: 'required' },
      { name: 'diagnose', description: '诊断插件状态', surfaceId: 'remote-mcp', tool: 'diagnose' },
    ],
    permissions: ['marketplace-read'],
    stats: { monthlyActiveUsers: 1200 },
  }),
  officialManifest({
    id: 'chatgpt-auto-confirm',
    version: '1.0.0+codex.20260810093000',
    title: 'ChatGPT 自动确认',
    description: '在桌面端运行可恢复任务队列并只自动确认非敏感授权卡。',
    categories: ['official', 'automation'],
    tags: ['chatgpt', '任务队列', '本地'],
    homepage: 'https://fabushi.ombhrum.com/miniapps/chatgpt-auto-confirm/',
    surfaces: [
      { id: 'remote-mcp', kind: 'mcp-http', url: 'https://api.ombhrum.com/api/mcp/apps/chatgpt-auto-confirm', platforms: ['desktop'], priority: 100 },
      { id: 'local-cli', kind: 'cli', command: 'mahayana miniapp run chatgpt-auto-confirm', platforms: ['desktop', 'cli'], local: true, priority: 90 },
      { id: 'web-ui', kind: 'web', url: 'https://fabushi.ombhrum.com/miniapps/chatgpt-auto-confirm/', platforms: ['desktop'], priority: 80 },
    ],
    commands: [
      { name: 'queue_status', description: '查看任务队列', surfaceId: 'remote-mcp', tool: 'queue_status' },
      { name: 'enqueue_tasks', description: '加入多步骤任务', surfaceId: 'remote-mcp', tool: 'enqueue_tasks', approval: 'required' },
      { name: 'start_queue', description: '启动或恢复队列', surfaceId: 'remote-mcp', tool: 'start_queue', approval: 'required' },
      { name: 'wait_for_review', description: '等待验收结果', surfaceId: 'remote-mcp', tool: 'wait_for_review' },
    ],
    permissions: ['local-execution', 'accessibility', 'browser-control'],
    stats: { monthlyActiveUsers: 500 },
  }),
  officialManifest({
    id: 'teleprompter-recorder',
    version: '1.0.0',
    title: '口播提词器',
    description: '从所属 Bot 发起视频通话，在自拍视频上显示提词器并录制；结束后自动把视频保存回同一会话。',
    categories: ['official', 'productivity', 'media'],
    tags: ['口播', '提词器', '视频录制', 'teleprompter', 'camera'],
    bot: {
      id: 'teleprompter-recorder-bot',
      username: 'teleprompter_recorder_bot',
      displayName: '口播提词器',
      description: '点击视频通话进入自拍提词和录制；录完的视频会回到本会话。',
      calls: {
        video: {
          type: 'miniapp-surface',
          title: '口播录制',
          surfaceId: 'web-ui',
          aiMode: 'disabled',
        },
      },
    },
    surfaces: [
      { id: 'web-ui', kind: 'web', title: '口播提词与录制控制', entry: 'index.html', platforms: ['desktop'], priority: 100 },
    ],
    commands: [
      { name: 'open_recorder', description: '打开口播提词与录制界面', surfaceId: 'web-ui', tool: 'open_recorder', aliases: ['打开提词器'], naturalLanguageHints: ['打开口播提词器', '开始口播录制'] },
    ],
    permissions: ['camera', 'microphone', 'conversation-media-write'],
    stats: { monthlyActiveUsers: 0 },
  }),
  officialManifest({
    id: 'douyin-batch-downloader',
    version: '1.0.0',
    title: '抖音批量无水印下载',
    description: '把用户有权访问的抖音分享批量解析并保存为本地无水印 MP4，附带去重、重试、摘要和失败清单。',
    categories: ['official', 'productivity', 'media'],
    tags: ['抖音', '无水印', '批量下载', '视频下载', '本地保存', 'douyin'],
    homepage: 'https://fabushi.ombhrum.com/miniapps/douyin-batch-downloader/',
    bot: {
      id: 'douyin-batch-downloader-bot',
      username: 'douyin_batch_downloader_bot',
      displayName: '抖音批量无水印下载',
      description: '粘贴有权访问的抖音分享链接，限速解析并保存到本地；不绕过登录、验证码或私密内容。',
    },
    surfaces: [
      { id: 'local-cli', kind: 'cli', title: '本地下载运行时', command: 'mahayana miniapp run douyin-batch-downloader', platforms: ['desktop', 'cli'], local: true, priority: 100 },
      { id: 'web-ui', kind: 'web', title: '使用说明', url: 'https://fabushi.ombhrum.com/miniapps/douyin-batch-downloader/', platforms: ['desktop'], priority: 50 },
    ],
    commands: [
      { name: 'resolve', description: '批量校验链接并解析无水印播放地址，不写视频文件', usage: '/douyin-batch-downloader:resolve {"urls":["https://v.douyin.com/..."]}', surfaceId: 'local-cli', tool: 'resolve', aliases: ['解析'], naturalLanguageHints: ['解析这些抖音链接', '检查无水印地址'] },
      { name: 'download', description: '批量下载到本地并生成 manifest.json', usage: '/douyin-batch-downloader:download {"urls":["https://v.douyin.com/..."],"outputDir":"douyin-videos"}', surfaceId: 'local-cli', tool: 'download', approval: 'required', aliases: ['下载'], naturalLanguageHints: ['下载这些抖音视频到本地', '批量无水印下载'] },
    ],
    permissions: ['network', 'local-files', 'local-execution'],
    stats: { monthlyActiveUsers: 0 },
  }),
];

export function officialMiniAppManifests() {
  return officialSeeds.map(clone);
}

export function marketplaceSummary(manifest) {
  return {
    pluginId: manifest.id,
    displayName: manifest.title,
    description: manifest.description,
    latestVersion: manifest.version,
    platforms: [...new Set(manifest.surfaces.flatMap((surface) => surface.platforms))],
    releaseStatus: manifest.review.state,
    releaseManifest: createReleaseMetadata(manifest).releaseManifest,
    source: {
      protocol: manifest.protocol,
      publisher: manifest.publisher,
      repository: manifest.distribution.repository,
      manifestUrl: manifest.distribution.manifestUrl,
      bot: manifest.bot,
      surfaces: manifest.surfaces,
      commands: manifest.commands,
      installMode: manifest.distribution.installMode,
      digest: manifest.digest,
    },
  };
}

export function createReleaseMetadata(manifestInput, platform = 'desktop') {
  const manifest = normalizeMiniAppManifest(manifestInput, { allowDraft: true });
  if (manifest.review.state !== 'approved') {
    throw new MiniAppMarketplaceError('RELEASE_NOT_APPROVED', `${manifest.id}@${manifest.version} is not approved`);
  }
  const matchingArtifacts = manifest.distribution.artifacts.filter((artifact) => artifact.platform === platform || artifact.platform === 'all');
  const selectedSurface = [...manifest.surfaces]
    .filter((surface) => surface.platforms.includes(platform) || surface.platforms.includes('all'))
    .sort((left, right) => right.priority - left.priority)[0] ?? manifest.surfaces[0];
  const releaseManifest = {
    protocol: MINIAPP_RELEASE_PROTOCOL,
    pluginId: manifest.id,
    version: manifest.version,
    publisher: manifest.publisher,
    releaseStatus: manifest.review.state,
    digest: manifest.digest,
    installMode: manifest.distribution.installMode,
    runtime: selectedSurface.kind,
    entry: selectedSurface.url ?? selectedSurface.entry ?? selectedSurface.command,
    surface: selectedSurface,
    surfaces: manifest.surfaces,
    bot: manifest.bot,
    commands: manifest.commands,
    requestedPermissions: manifest.permissions,
    source: {
      repository: manifest.distribution.repository,
      manifestUrl: manifest.distribution.manifestUrl,
      sourceRef: manifest.distribution.sourceRef,
      marketplaceHostsPackage: false,
    },
    artifacts: matchingArtifacts,
  };
  return {
    pluginId: manifest.id,
    version: manifest.version,
    releaseStatus: manifest.review.state,
    releaseManifest,
  };
}

export function renderMiniAppHomeDocument(manifestInput) {
  const manifest = normalizeMiniAppManifest(manifestInput, { allowDraft: true });
  const webSurface = [...manifest.surfaces]
    .filter((surface) => surface.kind === 'web')
    .sort((left, right) => right.priority - left.priority)[0];
  const commandButtons = manifest.commands
    .map((command) => `<button type="button" data-command="/${escapeHtml(manifest.id)}:${escapeHtml(command.name)}">/${escapeHtml(command.name)}</button>`)
    .join('');
  const remoteFrame = webSurface?.url
    ? `<iframe title="${escapeHtml(manifest.title)}" src="${escapeHtml(webSurface.url)}" referrerpolicy="no-referrer" sandbox="allow-forms allow-scripts allow-popups allow-same-origin"></iframe>`
    : '<section class="empty">这个小程序只提供命令或 MCP 能力，请在机器人会话中输入 / 查看命令。</section>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src https: http://localhost:*; img-src https: data:; connect-src https:"><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:#0d1520;color:#eef5ff;display:grid;grid-template-rows:auto 1fr;min-height:100vh}header{padding:14px 16px;border-bottom:1px solid #2c3e53;background:#111d2b}h1{font-size:18px;margin:0 0 4px}.description{margin:0 0 10px;color:#a8bbd1}.commands{display:flex;gap:8px;overflow:auto;padding-bottom:2px}button{border:1px solid #38506d;border-radius:10px;background:#17283a;color:inherit;padding:7px 10px;white-space:nowrap}iframe{width:100%;height:100%;border:0;background:white}.empty{padding:24px;color:#b9c8da}</style></head><body><header><h1>${escapeHtml(manifest.title)}</h1><p class="description">${escapeHtml(manifest.description)}</p><div class="commands">${commandButtons}</div></header>${remoteFrame}<script>document.querySelectorAll('[data-command]').forEach((button)=>button.addEventListener('click',()=>parent.postMessage({type:'fabushi-miniapp-command',miniAppId:${JSON.stringify(manifest.id)},command:button.dataset.command},'*')))</script></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function defaultStoreDocument() {
  return {
    protocol: MINIAPP_MARKETPLACE_PROTOCOL,
    schemaVersion: 2,
    sequence: 0,
    apps: [],
    addedByScope: {},
  };
}

export class MiniAppMarketplace {
  constructor({ storagePath, seed = officialSeeds, now = () => Date.now() } = {}) {
    this.storagePath = storagePath ?? process.env.FABUSHI_MINIAPP_MARKETPLACE_PATH ?? DEFAULT_STORAGE_PATH;
    this.seed = seed.map((manifest) => normalizeMiniAppManifest(manifest, { allowDraft: true }));
    this.now = now;
    this.document = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.storagePath)) return defaultStoreDocument();
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
    } catch (error) {
      throw new MiniAppMarketplaceError('STORE_CORRUPT', `failed to read marketplace store: ${error.message}`);
    }
    if (parsed?.protocol !== MINIAPP_MARKETPLACE_PROTOCOL || parsed?.schemaVersion !== 2 || !Array.isArray(parsed.apps)) {
      throw new MiniAppMarketplaceError('STORE_CORRUPT', 'marketplace store uses an unsupported schema');
    }
    return {
      protocol: MINIAPP_MARKETPLACE_PROTOCOL,
      schemaVersion: 2,
      sequence: Number.isSafeInteger(parsed.sequence) ? parsed.sequence : 0,
      apps: parsed.apps.map((manifest) => normalizeMiniAppManifest(manifest, { allowDraft: true })),
      addedByScope: parsed.addedByScope && typeof parsed.addedByScope === 'object' ? parsed.addedByScope : {},
    };
  }

  #persist() {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.storagePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.storagePath);
  }

  #all({ includeUnapproved = false } = {}) {
    const merged = new Map(this.seed.map((manifest) => [manifest.id, manifest]));
    for (const manifest of this.document.apps) merged.set(manifest.id, manifest);
    return [...merged.values()].filter((manifest) => includeUnapproved || manifest.review.state === 'approved');
  }

  list(options = {}) {
    return this.#all(options).map(clone);
  }

  get(id, options = {}) {
    const normalizedId = String(id ?? '').trim().toLocaleLowerCase();
    return clone(this.#all({ includeUnapproved: options.includeUnapproved }).find((manifest) => manifest.id === normalizedId) ?? null);
  }

  browse({ query = '', platform, scopeId = 'anonymous', limit = 50, includeUnapproved = false } = {}) {
    const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase();
    const added = new Set(this.document.addedByScope[String(scopeId)] ?? []);
    const apps = this.#all({ includeUnapproved })
      .filter((manifest) => !platform || manifest.surfaces.some((surface) => surface.platforms.includes(platform) || surface.platforms.includes('all')))
      .map((manifest) => ({ manifest, score: searchScore(manifest, normalizedQuery) }))
      .filter(({ manifest, score }) => !normalizedQuery || score > 0 || searchText(manifest).includes(normalizedQuery))
      .sort((left, right) => right.score - left.score || right.manifest.stats.monthlyActiveUsers - left.manifest.stats.monthlyActiveUsers || left.manifest.title.localeCompare(right.manifest.title))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map(({ manifest }) => ({ ...marketplaceSummary(manifest), added: added.has(manifest.id) }));
    return { protocol: MINIAPP_MARKETPLACE_PROTOCOL, plugins: apps };
  }

  createDraft(input) {
    const manifest = normalizeMiniAppManifest({
      ...input,
      review: { ...(input.review ?? {}), state: 'draft' },
      updatedAt: this.now(),
    }, { allowDraft: true });
    this.#upsert(manifest);
    return clone(manifest);
  }

  submit(id, publisherId) {
    const manifest = this.#owned(id, publisherId);
    manifest.review = { state: 'pending_review', submittedAt: this.now() };
    manifest.updatedAt = this.now();
    manifest.digest = normalizeMiniAppManifest(manifest, { allowDraft: true }).digest;
    this.#upsert(manifest);
    return clone(manifest);
  }

  review(id, { approved, reviewer, notes } = {}) {
    const manifest = this.get(id, { includeUnapproved: true });
    if (!manifest) throw new MiniAppMarketplaceError('NOT_FOUND', `mini app ${id} was not found`);
    if (manifest.review.state !== 'pending_review' && manifest.review.state !== 'validating') {
      throw new MiniAppMarketplaceError('INVALID_STATE', `mini app ${id} is not awaiting review`);
    }
    manifest.review = {
      state: approved ? 'approved' : 'rejected',
      reviewedAt: this.now(),
      reviewer: requiredText(reviewer ?? 'marketplace-reviewer', 'reviewer', 120),
      notes: optionalText(notes, 1000),
      submittedAt: manifest.review.submittedAt,
    };
    manifest.updatedAt = this.now();
    this.#upsert(normalizeMiniAppManifest(manifest, { allowDraft: true }));
    return this.get(id, { includeUnapproved: true });
  }

  yank(id, publisherId, notes) {
    const manifest = this.#owned(id, publisherId);
    manifest.review = {
      ...manifest.review,
      state: 'yanked',
      notes: optionalText(notes, 1000),
      reviewedAt: this.now(),
    };
    manifest.updatedAt = this.now();
    this.#upsert(normalizeMiniAppManifest(manifest, { allowDraft: true }));
    return this.get(id, { includeUnapproved: true });
  }

  add(id, scopeId = 'anonymous') {
    const manifest = this.get(id);
    if (!manifest) throw new MiniAppMarketplaceError('NOT_FOUND', `approved mini app ${id} was not found`);
    const key = String(scopeId || 'anonymous');
    const current = new Set(this.document.addedByScope[key] ?? []);
    current.add(manifest.id);
    this.document.addedByScope[key] = [...current].sort();
    this.document.sequence += 1;
    this.#persist();
    return {
      added: true,
      miniApp: manifest,
      bot: manifest.bot,
      release: createReleaseMetadata(manifest),
    };
  }

  remove(id, scopeId = 'anonymous') {
    const key = String(scopeId || 'anonymous');
    const current = new Set(this.document.addedByScope[key] ?? []);
    const removed = current.delete(String(id).trim().toLocaleLowerCase());
    this.document.addedByScope[key] = [...current].sort();
    this.document.sequence += 1;
    this.#persist();
    return { removed, miniAppId: String(id).trim().toLocaleLowerCase() };
  }

  added(scopeId = 'anonymous') {
    const ids = new Set(this.document.addedByScope[String(scopeId)] ?? []);
    return this.#all().filter((manifest) => ids.has(manifest.id)).map(clone);
  }

  commands(id) {
    const manifest = this.get(id);
    if (!manifest) throw new MiniAppMarketplaceError('NOT_FOUND', `mini app ${id} was not found`);
    return manifest.commands.map((command) => ({
      ...command,
      slash: `/${manifest.id}:${command.name}`,
    }));
  }

  routeInput(id, input) {
    const manifest = this.get(id);
    if (!manifest) throw new MiniAppMarketplaceError('NOT_FOUND', `mini app ${id} was not found`);
    const text = requiredText(input, 'input', 10000);
    const slash = text.match(/^\/([a-z0-9-]+):([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i);
    if (slash) {
      if (slash[1].toLocaleLowerCase() !== manifest.id) {
        throw new MiniAppMarketplaceError('COMMAND_MISMATCH', `command targets ${slash[1]}, not ${manifest.id}`);
      }
      const requested = slash[2].toLocaleLowerCase();
      const command = manifest.commands.find((candidate) => candidate.name === requested || candidate.aliases.includes(requested));
      if (!command) throw new MiniAppMarketplaceError('COMMAND_NOT_FOUND', `unknown command ${requested}`);
      return {
        kind: 'command',
        miniAppId: manifest.id,
        bot: manifest.bot,
        command,
        arguments: parseCommandArguments(slash[3]),
      };
    }
    const normalized = text.toLocaleLowerCase();
    const ranked = manifest.commands
      .map((command) => ({
        command,
        score: [command.name, command.description, ...command.aliases, ...command.naturalLanguageHints]
          .reduce((score, phrase) => score + (normalized.includes(String(phrase).toLocaleLowerCase()) ? 1 : 0), 0),
      }))
      .sort((left, right) => right.score - left.score);
    return {
      kind: 'natural-language',
      miniAppId: manifest.id,
      bot: manifest.bot,
      input: text,
      suggestedCommand: ranked[0]?.score > 0 ? ranked[0].command : null,
      surface: manifest.surfaces[0],
      requiresMahayanaPlanning: true,
    };
  }

  generationWorkflow({ prompt, publisher, id, title, description, surfaces, repository } = {}) {
    const normalizedPublisherValue = normalizedPublisher(publisher);
    const proposedId = String(id ?? title ?? 'new-miniapp')
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
    if (!ID_PATTERN.test(proposedId)) {
      throw new MiniAppMarketplaceError('INVALID_MANIFEST', 'a valid mini app id is required for generation');
    }
    const spec = {
      id: proposedId,
      title: requiredText(title ?? proposedId, 'title', 120),
      description: requiredText(description ?? prompt, 'description', 500),
      prompt: requiredText(prompt, 'prompt', 10000),
      publisher: normalizedPublisherValue,
      requestedSurfaces: normalizedStringArray(surfaces ?? ['web', 'mcp-http'], 'surfaces', 6),
      repository: normalizedUrl(repository ?? 'https://github.com/bhrum/fabushi', 'repository'),
    };
    const workflowId = `miniapp-generation-${proposedId}-${crypto.randomUUID()}`;
    return {
      protocol: MINIAPP_GENERATION_PROTOCOL,
      workflowId,
      mode: 'mahayana-agent',
      miniAppId: proposedId,
      botId: `${proposedId}-bot`,
      spec,
      acceptance: [
        'manifest validates against fabushi.miniapp.manifest.v2',
        'at least one GUI, MCP, CLI, WASM or native surface is executable',
        'slash commands are generated from the same command declarations used by the bot',
        'tests pass before a release source is submitted',
        'marketplace stores metadata and hashes only; package bytes remain at the publisher source',
        'review approval is required before global search visibility',
      ],
      steps: [
        { id: 'spec', title: '固化需求与运行形态', tool: 'generate_and_submit_miniapp', dependsOn: [], state: 'ready' },
        { id: 'scaffold', title: '生成小程序与默认机器人', tool: 'create_plugin', dependsOn: ['spec'], state: 'blocked' },
        { id: 'validate', title: '验证清单、命令、权限与 UI', tool: 'validate_plugin', dependsOn: ['scaffold'], state: 'blocked' },
        { id: 'test', title: '运行自动化测试', tool: 'build_plugin', dependsOn: ['validate'], state: 'blocked' },
        { id: 'publish-source', title: '推送 GitHub/发布者源并生成哈希', tool: 'publish_plugin', dependsOn: ['test'], state: 'blocked' },
        { id: 'submit-review', title: '提交市场审核', tool: 'market_submit', dependsOn: ['publish-source'], state: 'blocked' },
        { id: 'verify-discovery', title: '验证搜索、添加、Bot、命令和 GUI', tool: 'market_search', dependsOn: ['submit-review'], state: 'blocked' },
      ],
    };
  }

  #owned(id, publisherId) {
    const manifest = this.get(id, { includeUnapproved: true });
    if (!manifest) throw new MiniAppMarketplaceError('NOT_FOUND', `mini app ${id} was not found`);
    if (manifest.publisher.id !== String(publisherId ?? '').trim().toLocaleLowerCase()) {
      throw new MiniAppMarketplaceError('FORBIDDEN', 'publisher does not own this mini app');
    }
    return manifest;
  }

  #upsert(manifest) {
    const index = this.document.apps.findIndex((candidate) => candidate.id === manifest.id);
    if (index >= 0) this.document.apps[index] = manifest;
    else this.document.apps.push(manifest);
    this.document.sequence += 1;
    this.#persist();
  }
}

function parseCommandArguments(raw) {
  if (!raw) return {};
  const trimmed = String(raw).trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Keep raw text below.
    }
  }
  return { text: trimmed };
}

export class MiniAppMarketplaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MiniAppMarketplaceError';
    this.code = code;
  }
}
