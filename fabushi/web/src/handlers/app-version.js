import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { isAdmin } from '../utils/helpers.js';

const DEFAULT_RELEASE_NOTES = [
  '优化启动体验与稳定性',
  '修复已知问题并改进细节表现'
];

const DEFAULT_TITLE = '发现新版本';
const DEFAULT_MESSAGE = '新版本已发布，建议尽快更新以获得更稳定的体验。';

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function parseInteger(value, fallbackValue) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

function parseBoolean(value, fallbackValue = false) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallbackValue;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (['android', 'ios', 'web', 'macos', 'windows', 'linux'].includes(normalized)) {
    return normalized;
  }
  return 'unknown';
}

function normalizeChannel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'stable';
}

function normalizeReleaseNotes(value) {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    return items.length > 0 ? items : [...DEFAULT_RELEASE_NOTES];
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return normalizeReleaseNotes(parsed);
        }
      } catch (_) {
        // fall through to plain text parsing
      }
    }
    const items = trimmed
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : [...DEFAULT_RELEASE_NOTES];
  }
  return [...DEFAULT_RELEASE_NOTES];
}

function compareVersions(left, right) {
  const leftParts = String(left || '0')
    .split('.')
    .map((item) => Number.parseInt(item, 10) || 0);
  const rightParts = String(right || '0')
    .split('.')
    .map((item) => Number.parseInt(item, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  return 0;
}

function shouldUpdate(clientVersion, clientBuildNumber, policy) {
  if (clientBuildNumber >= 0 && clientBuildNumber < policy.latestBuildNumber) {
    return true;
  }
  return compareVersions(clientVersion, policy.latestVersion) < 0;
}

function resolveDownloadUrl(platform, env) {
  const platformKey = platform.toUpperCase();
  return pickFirst(
    env[`APP_VERSION_DOWNLOAD_URL_${platformKey}`],
    env.APP_VERSION_DOWNLOAD_URL,
    platform === 'web' ? env.FRONTEND_URL : '',
    env.FRONTEND_URL,
    env.WORKER_URL,
    'https://flutter.ombhrum.com'
  );
}

function buildFallbackPolicy(platform, channel, env) {
  const platformKey = platform.toUpperCase();
  const channelKey = channel.toUpperCase();
  const latestVersion = pickFirst(
    env[`APP_VERSION_LATEST_VERSION_${platformKey}_${channelKey}`],
    env[`APP_VERSION_LATEST_VERSION_${platformKey}`],
    env[`APP_VERSION_LATEST_VERSION_${channelKey}`],
    env.APP_VERSION_LATEST_VERSION,
    '1.0.0'
  );
  const latestBuildNumber = parseInteger(
    pickFirst(
      env[`APP_VERSION_LATEST_BUILD_${platformKey}_${channelKey}`],
      env[`APP_VERSION_LATEST_BUILD_${platformKey}`],
      env[`APP_VERSION_LATEST_BUILD_${channelKey}`],
      env.APP_VERSION_LATEST_BUILD,
      '16'
    ),
    16
  );
  const minSupportedBuildNumber = parseInteger(
    pickFirst(
      env[`APP_VERSION_MIN_SUPPORTED_BUILD_${platformKey}_${channelKey}`],
      env[`APP_VERSION_MIN_SUPPORTED_BUILD_${platformKey}`],
      env[`APP_VERSION_MIN_SUPPORTED_BUILD_${channelKey}`],
      env.APP_VERSION_MIN_SUPPORTED_BUILD,
      '1'
    ),
    1
  );
  const rolloutPercentage = clamp(
    parseInteger(
      pickFirst(
        env[`APP_VERSION_ROLLOUT_PERCENTAGE_${platformKey}_${channelKey}`],
        env[`APP_VERSION_ROLLOUT_PERCENTAGE_${platformKey}`],
        env[`APP_VERSION_ROLLOUT_PERCENTAGE_${channelKey}`],
        env.APP_VERSION_ROLLOUT_PERCENTAGE,
        '100'
      ),
      100
    ),
    0,
    100
  );
  const promptIntervalHours = Math.max(
    1,
    parseInteger(env.APP_VERSION_PROMPT_INTERVAL_HOURS, 24)
  );
  const releaseNotes = normalizeReleaseNotes(
    pickFirst(env.APP_VERSION_RELEASE_NOTES, DEFAULT_RELEASE_NOTES.join('\n'))
  );
  const forceUpdate = parseBoolean(env.APP_VERSION_FORCE_UPDATE, false);
  const allowSkip = parseBoolean(env.APP_VERSION_ALLOW_SKIP, true) && !forceUpdate;

  return {
    enabled: parseBoolean(env.APP_VERSION_CHECK_ENABLED, true),
    platform,
    channel,
    latestVersion,
    latestBuildNumber,
    minSupportedBuildNumber,
    forceUpdate,
    allowSkip,
    rolloutPercentage,
    promptIntervalHours,
    publishedAt: pickFirst(env.APP_VERSION_PUBLISHED_AT, new Date().toISOString()),
    title: pickFirst(env.APP_VERSION_TITLE, DEFAULT_TITLE),
    message: pickFirst(env.APP_VERSION_MESSAGE, DEFAULT_MESSAGE),
    releaseNotes,
    downloadUrl: resolveDownloadUrl(platform, env),
    source: 'env-fallback',
    updatedAt: null,
    updatedBy: 'system',
  };
}

function serializePolicyRow(row, fallbackPolicy) {
  if (!row) {
    return fallbackPolicy;
  }

  return {
    enabled: row.enabled === 1,
    platform: row.platform,
    channel: row.channel,
    latestVersion: row.latest_version,
    latestBuildNumber: Number(row.latest_build_number) || fallbackPolicy.latestBuildNumber,
    minSupportedBuildNumber:
      Number(row.min_supported_build_number) || fallbackPolicy.minSupportedBuildNumber,
    forceUpdate: row.force_update === 1,
    allowSkip: row.allow_skip === 1,
    rolloutPercentage: Number(row.rollout_percentage) || fallbackPolicy.rolloutPercentage,
    promptIntervalHours:
      Number(row.prompt_interval_hours) || fallbackPolicy.promptIntervalHours,
    publishedAt: row.published_at || fallbackPolicy.publishedAt,
    title: row.title || fallbackPolicy.title,
    message: row.message || fallbackPolicy.message,
    releaseNotes: normalizeReleaseNotes(row.release_notes_json),
    downloadUrl: row.download_url || fallbackPolicy.downloadUrl,
    source: row.source || 'd1',
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || 'system',
  };
}

async function ensureTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS app_version_policies (
      platform TEXT NOT NULL,
      channel TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      latest_version TEXT NOT NULL,
      latest_build_number INTEGER NOT NULL,
      min_supported_build_number INTEGER NOT NULL DEFAULT 1,
      force_update INTEGER NOT NULL DEFAULT 0,
      allow_skip INTEGER NOT NULL DEFAULT 1,
      rollout_percentage INTEGER NOT NULL DEFAULT 100,
      prompt_interval_hours INTEGER NOT NULL DEFAULT 24,
      title TEXT NOT NULL DEFAULT '发现新版本',
      message TEXT NOT NULL DEFAULT '新版本已发布，建议尽快更新以获得更稳定的体验。',
      release_notes_json TEXT NOT NULL DEFAULT '[]',
      download_url TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      published_at TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (platform, channel)
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS app_version_policy_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      channel TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )
  `).run();
}

async function getStoredPolicy(db, platform, channel) {
  return await db.prepare(`
    SELECT *
    FROM app_version_policies
    WHERE platform = ? AND channel = ?
  `).bind(platform, channel).first();
}

async function authenticateAdmin(request, env, dbService) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: jsonResponse({ error: '未提供认证信息' }, 401) };
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData?.username) {
    return { error: jsonResponse({ error: '认证失败' }, 401) };
  }

  const user = await dbService.getUser(tokenData.username);
  if (!user) {
    return { error: jsonResponse({ error: '用户不存在' }, 404) };
  }
  if (!isAdmin(user.email)) {
    return { error: jsonResponse({ error: '权限不足' }, 403) };
  }

  return {
    actor: {
      username: user.username,
      email: user.email,
      source: 'admin-console',
    },
  };
}

function authenticateAutomation(request, env) {
  const provided = request.headers.get('X-Release-Automation-Token') || '';
  const expected = env.VERSION_POLICY_AUTOMATION_TOKEN || env.RELEASE_AUTOMATION_TOKEN || '';
  if (!expected || provided !== expected) {
    return null;
  }
  return {
    actor: {
      username: 'release-automation',
      email: '',
      source: 'release-automation',
    },
  };
}

async function resolveWriter(request, env, dbService, allowAutomationOnly = false) {
  const automation = authenticateAutomation(request, env);
  if (automation) {
    return automation;
  }
  if (allowAutomationOnly) {
    return { error: jsonResponse({ error: '自动化令牌无效' }, 401) };
  }
  return await authenticateAdmin(request, env, dbService);
}

function buildResponsePolicy(clientVersion, clientBuildNumber, policy) {
  const updateAvailable = policy.enabled
    ? shouldUpdate(clientVersion, clientBuildNumber, policy)
    : false;
  const hardBlockedByMinVersion =
    clientBuildNumber >= 0 && clientBuildNumber < policy.minSupportedBuildNumber;
  const forceUpdate = updateAvailable && (policy.forceUpdate || hardBlockedByMinVersion);

  return {
    ...policy,
    updateAvailable,
    forceUpdate,
    strategy: !updateAvailable ? 'none' : forceUpdate ? 'force' : 'optional',
    serverTime: new Date().toISOString(),
    client: {
      version: clientVersion,
      buildNumber: clientBuildNumber,
    },
  };
}

export async function handleAppVersionPolicy(request, env, dbService) {
  const url = new URL(request.url);
  const platform = normalizePlatform(url.searchParams.get('platform'));
  const channel = normalizeChannel(url.searchParams.get('channel'));
  const clientVersion = String(url.searchParams.get('version') || '0.0.0').trim();
  const clientBuildNumber = parseInteger(url.searchParams.get('buildNumber'), -1);

  const db = dbService.db || dbService;
  const fallbackPolicy = buildFallbackPolicy(platform, channel, env);

  try {
    await ensureTables(db);
    const stored = await getStoredPolicy(db, platform, channel);
    const policy = serializePolicyRow(stored, fallbackPolicy);
    return jsonResponse(buildResponsePolicy(clientVersion, clientBuildNumber, policy));
  } catch (error) {
    console.warn('读取版本策略失败，回退环境变量:', error?.message || error);
    return jsonResponse(
      buildResponsePolicy(clientVersion, clientBuildNumber, fallbackPolicy),
    );
  }
}

async function upsertPolicy(request, env, dbService, { automationOnly = false } = {}) {
  const auth = await resolveWriter(request, env, dbService, automationOnly);
  if (auth.error) {
    return auth.error;
  }

  const body = await request.json();
  const platform = normalizePlatform(body.platform);
  const channel = normalizeChannel(body.channel);
  if (platform === 'unknown') {
    return jsonResponse({ error: 'platform 不合法' }, 400);
  }

  const db = dbService.db || dbService;
  const fallbackPolicy = buildFallbackPolicy(platform, channel, env);
  await ensureTables(db);
  const existingRow = await getStoredPolicy(db, platform, channel);
  const existing = serializePolicyRow(existingRow, fallbackPolicy);

  const latestVersion = pickFirst(body.latestVersion, existing.latestVersion);
  const latestBuildNumber = parseInteger(
    body.latestBuildNumber,
    existing.latestBuildNumber,
  );
  const minSupportedBuildNumber = parseInteger(
    body.minSupportedBuildNumber,
    existing.minSupportedBuildNumber,
  );
  const forceUpdate = parseBoolean(body.forceUpdate, existing.forceUpdate);
  const allowSkip = parseBoolean(body.allowSkip, existing.allowSkip) && !forceUpdate;
  const rolloutPercentage = clamp(
    parseInteger(body.rolloutPercentage, existing.rolloutPercentage),
    0,
    100,
  );
  const promptIntervalHours = Math.max(
    1,
    parseInteger(body.promptIntervalHours, existing.promptIntervalHours),
  );
  const title = pickFirst(body.title, existing.title, DEFAULT_TITLE);
  const message = pickFirst(body.message, existing.message, DEFAULT_MESSAGE);
  const releaseNotes = normalizeReleaseNotes(
    body.releaseNotes !== undefined ? body.releaseNotes : existing.releaseNotes,
  );
  const downloadUrl = pickFirst(body.downloadUrl, existing.downloadUrl, fallbackPolicy.downloadUrl);
  const enabled = parseBoolean(body.enabled, existing.enabled);
  const source = pickFirst(body.source, auth.actor.source, existing.source, 'manual');
  const publishedAt = pickFirst(body.publishedAt, existing.publishedAt, new Date().toISOString());
  const updatedAt = new Date().toISOString();
  const updatedBy = auth.actor.username;

  await db.prepare(`
    INSERT INTO app_version_policies (
      platform,
      channel,
      enabled,
      latest_version,
      latest_build_number,
      min_supported_build_number,
      force_update,
      allow_skip,
      rollout_percentage,
      prompt_interval_hours,
      title,
      message,
      release_notes_json,
      download_url,
      source,
      published_at,
      updated_at,
      updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, channel) DO UPDATE SET
      enabled = excluded.enabled,
      latest_version = excluded.latest_version,
      latest_build_number = excluded.latest_build_number,
      min_supported_build_number = excluded.min_supported_build_number,
      force_update = excluded.force_update,
      allow_skip = excluded.allow_skip,
      rollout_percentage = excluded.rollout_percentage,
      prompt_interval_hours = excluded.prompt_interval_hours,
      title = excluded.title,
      message = excluded.message,
      release_notes_json = excluded.release_notes_json,
      download_url = excluded.download_url,
      source = excluded.source,
      published_at = excluded.published_at,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).bind(
    platform,
    channel,
    enabled ? 1 : 0,
    latestVersion,
    latestBuildNumber,
    minSupportedBuildNumber,
    forceUpdate ? 1 : 0,
    allowSkip ? 1 : 0,
    rolloutPercentage,
    promptIntervalHours,
    title,
    message,
    JSON.stringify(releaseNotes),
    downloadUrl,
    source,
    publishedAt,
    updatedAt,
    updatedBy,
  ).run();

  const payloadForAudit = {
    platform,
    channel,
    enabled,
    latestVersion,
    latestBuildNumber,
    minSupportedBuildNumber,
    forceUpdate,
    allowSkip,
    rolloutPercentage,
    promptIntervalHours,
    title,
    message,
    releaseNotes,
    downloadUrl,
    source,
    publishedAt,
    updatedAt,
    updatedBy,
  };

  await db.prepare(`
    INSERT INTO app_version_policy_audit (
      platform,
      channel,
      payload_json,
      source,
      updated_at,
      updated_by
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    platform,
    channel,
    JSON.stringify(payloadForAudit),
    source,
    updatedAt,
    updatedBy,
  ).run();

  return jsonResponse({ success: true, policy: payloadForAudit });
}

export async function handleAdminUpsertAppVersionPolicy(request, env, dbService) {
  try {
    return await upsertPolicy(request, env, dbService, { automationOnly: false });
  } catch (error) {
    console.error('管理员更新版本策略失败:', error);
    return jsonResponse({ error: error.message || '更新版本策略失败' }, 500);
  }
}

export async function handleAutomationSyncAppVersionPolicy(request, env, dbService) {
  try {
    return await upsertPolicy(request, env, dbService, { automationOnly: true });
  } catch (error) {
    console.error('自动同步版本策略失败:', error);
    return jsonResponse({ error: error.message || '自动同步版本策略失败' }, 500);
  }
}
