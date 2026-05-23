import { jsonResponse } from '../utils/response.js';

const DEFAULT_RELEASE_NOTES = [
  '优化启动体验与稳定性',
  '修复已知问题并改进细节表现'
];

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
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
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

function buildPolicy(platform, channel, env) {
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
      String(latestBuildNumber)
    ),
    latestBuildNumber
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
    channel,
    platform,
    latestVersion,
    latestBuildNumber,
    minSupportedBuildNumber,
    forceUpdate,
    allowSkip,
    rolloutPercentage,
    promptIntervalHours,
    publishedAt: pickFirst(env.APP_VERSION_PUBLISHED_AT, new Date().toISOString()),
    title: pickFirst(env.APP_VERSION_TITLE, '发现新版本'),
    message: pickFirst(
      env.APP_VERSION_MESSAGE,
      '新版本已发布，建议尽快更新以获得更稳定的体验。'
    ),
    releaseNotes,
    downloadUrl: resolveDownloadUrl(platform, env)
  };
}

export async function handleAppVersionPolicy(request, env) {
  const url = new URL(request.url);
  const platform = normalizePlatform(url.searchParams.get('platform'));
  const channel = normalizeChannel(url.searchParams.get('channel'));
  const clientVersion = String(url.searchParams.get('version') || '0.0.0').trim();
  const clientBuildNumber = parseInteger(url.searchParams.get('buildNumber'), -1);

  const policy = buildPolicy(platform, channel, env);
  const updateAvailable = policy.enabled
    ? shouldUpdate(clientVersion, clientBuildNumber, policy)
    : false;
  const hardBlockedByMinVersion =
    clientBuildNumber >= 0 && clientBuildNumber < policy.minSupportedBuildNumber;
  const forceUpdate = updateAvailable && (policy.forceUpdate || hardBlockedByMinVersion);

  return jsonResponse({
    ...policy,
    updateAvailable,
    forceUpdate,
    strategy: !updateAvailable ? 'none' : forceUpdate ? 'force' : 'optional',
    serverTime: new Date().toISOString(),
    client: {
      version: clientVersion,
      buildNumber: clientBuildNumber
    }
  });
}
