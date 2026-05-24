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

function normalizeReleaseNotes(value) {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    return items.length > 0 ? items : [...DEFAULT_RELEASE_NOTES];
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return [...DEFAULT_RELEASE_NOTES];
    }
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return normalizeReleaseNotes(parsed);
        }
      } catch (_) {
        // fall through to line splitting
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

function resolveDownloadUrl(platform, env) {
  const platformKey = platform.toUpperCase();
  return pickFirst(
    env[`APP_VERSION_DOWNLOAD_URL_${platformKey}`],
    env[`APP_DOWNLOAD_URL_${platformKey}`],
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
  return {
    enabled: parseBoolean(env.APP_VERSION_CHECK_ENABLED, true),
    platform,
    channel,
    latestVersion: pickFirst(
      env[`APP_VERSION_LATEST_VERSION_${platformKey}_${channelKey}`],
      env[`APP_VERSION_LATEST_VERSION_${platformKey}`],
      env[`APP_VERSION_LATEST_VERSION_${channelKey}`],
      env.APP_VERSION_LATEST_VERSION,
      '1.0.0'
    ),
    latestBuildNumber: parseInteger(
      pickFirst(
        env[`APP_VERSION_LATEST_BUILD_${platformKey}_${channelKey}`],
        env[`APP_VERSION_LATEST_BUILD_${platformKey}`],
        env[`APP_VERSION_LATEST_BUILD_${channelKey}`],
        env.APP_VERSION_LATEST_BUILD,
        '16'
      ),
      16
    ),
    publishedAt: pickFirst(env.APP_VERSION_PUBLISHED_AT, new Date().toISOString()),
    releaseNotes: normalizeReleaseNotes(
      pickFirst(env.APP_VERSION_RELEASE_NOTES, DEFAULT_RELEASE_NOTES.join('\n'))
    ),
    downloadUrl: resolveDownloadUrl(platform, env),
    source: 'env-fallback'
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
    latestVersion: row.latest_version || fallbackPolicy.latestVersion,
    latestBuildNumber: Number(row.latest_build_number) || fallbackPolicy.latestBuildNumber,
    publishedAt: row.published_at || fallbackPolicy.publishedAt,
    releaseNotes: normalizeReleaseNotes(row.release_notes_json),
    downloadUrl: row.download_url || fallbackPolicy.downloadUrl,
    source: row.source || fallbackPolicy.source || 'd1'
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

async function listStoredPolicies(db) {
  const result = await db.prepare(`
    SELECT *
    FROM app_version_policies
    WHERE enabled = 1
      AND platform IN ('android', 'ios')
      AND channel IN ('beta', 'stable')
    ORDER BY
      CASE channel WHEN 'beta' THEN 0 ELSE 1 END,
      CASE platform WHEN 'android' THEN 0 ELSE 1 END,
      updated_at DESC
  `).all();
  return Array.isArray(result?.results) ? result.results : [];
}

async function listPolicyAuditRows(db) {
  const result = await db.prepare(`
    SELECT *
    FROM app_version_policy_audit
    WHERE platform IN ('android', 'ios')
      AND channel IN ('beta', 'stable')
    ORDER BY updated_at DESC, id DESC
    LIMIT 24
  `).all();
  return Array.isArray(result?.results) ? result.results : [];
}

function uniqueLines(items, limit = 4) {
  const seen = new Set();
  const lines = [];
  for (const item of items) {
    const normalized = String(item || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(normalized);
    if (lines.length >= limit) break;
  }
  return lines;
}

function getChannelTitle(platform, channel) {
  const platformLabel = platform === 'ios' ? 'iOS' : 'Android';
  return `${platformLabel} ${channel === 'beta' ? 'Beta' : '正式版'}`;
}

function getChannelStatus(policy) {
  if (!policy.downloadUrl) {
    return policy.channel === 'beta' ? '暂未开放' : '待人工验证';
  }
  if (policy.platform === 'ios' && policy.downloadUrl.includes('testflight.apple.com')) {
    return policy.channel === 'beta' ? 'TestFlight 已开放' : 'App Store 已开放';
  }
  return policy.channel === 'beta' ? 'Beta 自动同步' : '正式版已同步';
}

function getChannelDescription(policy) {
  if (!policy.downloadUrl) {
    return policy.channel === 'beta'
      ? '当前还没有公开可点击的测试入口。'
      : '正式版会在人工验收通过后开放，适合首次安装和长期使用。';
  }

  if (policy.platform === 'ios') {
    return policy.channel === 'beta'
      ? 'iOS 测试版通过 Apple TestFlight 分发。'
      : 'iOS 正式版入口已经同步到官网，可直接前往更新。';
  }

  return policy.channel === 'beta'
    ? '官网按钮会直接打开当前 Android 测试版下载入口。'
    : '官网按钮会直接打开当前 Android 正式版下载入口。';
}

function getChannelPrimaryLabel(policy) {
  if (!policy.downloadUrl) {
    return policy.channel === 'beta' ? '等待测试入口开放' : '等待正式版上线';
  }
  const platformLabel = policy.platform === 'ios' ? 'iOS' : 'Android';
  return `下载 ${platformLabel} ${policy.channel === 'beta' ? '测试版' : '正式版'}`;
}

function getChannelNote(policy) {
  if (!policy.downloadUrl) {
    return policy.channel === 'beta'
      ? '新版本同步后，这里会自动显示可访问入口。'
      : '正式版审核通过后，这里会自动切换为公开入口。';
  }
  if (policy.platform === 'ios' && policy.downloadUrl.includes('testflight.apple.com')) {
    return '点击后会打开 Apple TestFlight 页面。';
  }
  return policy.channel === 'beta'
    ? '官网展示的测试版信息会随 Cloudflare 中的版本策略同步更新。'
    : '官网展示的正式版信息会随 Cloudflare 中的版本策略同步更新。';
}

function buildOfficialSiteChannel(policy) {
  return {
    platform: policy.platform === 'ios' ? 'iOS' : 'Android',
    audience: policy.channel === 'beta' ? 'beta' : 'stable',
    status: getChannelStatus(policy),
    title: getChannelTitle(policy.platform, policy.channel),
    description: getChannelDescription(policy),
    primaryLabel: getChannelPrimaryLabel(policy),
    primaryHref: policy.downloadUrl || '/contact',
    version: policy.latestVersion,
    publishedAt: policy.publishedAt,
    updateSummary: uniqueLines(policy.releaseNotes),
    mirrorLinks: [],
    note: getChannelNote(policy),
    releasePageHref: '/download#release-changelog'
  };
}

function parseAuditPayload(row) {
  try {
    const payload = JSON.parse(row.payload_json || '{}');
    return payload && typeof payload === 'object' ? payload : null;
  } catch (_) {
    return null;
  }
}

function buildReleaseEntry(payload, fallbackPublishedAt) {
  const latestVersion = pickFirst(payload.latestVersion, '1.0.0');
  const latestBuildNumber = parseInteger(payload.latestBuildNumber, 0);
  const publishedAt = pickFirst(payload.publishedAt, payload.updatedAt, fallbackPublishedAt, new Date().toISOString());
  const summary = uniqueLines([
    ...normalizeReleaseNotes(payload.releaseNotes),
    payload.message,
    payload.title
  ]);
  const tag = latestVersion.startsWith('v') ? latestVersion : `v${latestVersion}`;
  return {
    tag,
    title: `Fabushi ${latestVersion}${latestBuildNumber > 0 ? `+${latestBuildNumber}` : ''}`,
    publishedAt,
    htmlUrl: '',
    summary,
    buildNumber: latestBuildNumber
  };
}

function buildReleaseEntries(auditRows, currentPolicies) {
  const entries = [];
  for (const row of auditRows) {
    const payload = parseAuditPayload(row);
    if (!payload) continue;
    entries.push(buildReleaseEntry(payload, row.updated_at));
  }

  if (entries.length === 0) {
    for (const policy of currentPolicies) {
      entries.push(buildReleaseEntry(policy, policy.publishedAt));
    }
  }

  const merged = new Map();
  for (const entry of entries) {
    const key = entry.tag;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...entry,
        summary: uniqueLines(entry.summary)
      });
      continue;
    }

    const incomingBuildNumber = parseInteger(entry.buildNumber, 0);
    const existingBuildNumber = parseInteger(existing.buildNumber, 0);
    const incomingPublishedAt = String(entry.publishedAt || '');
    const existingPublishedAt = String(existing.publishedAt || '');
    const incomingIsNewer =
      incomingBuildNumber > existingBuildNumber ||
      (incomingBuildNumber === existingBuildNumber && incomingPublishedAt > existingPublishedAt);

    if (incomingIsNewer) {
      merged.set(key, {
        ...entry,
        summary:
          incomingBuildNumber === existingBuildNumber
            ? uniqueLines([...existing.summary, ...entry.summary])
            : uniqueLines(entry.summary)
      });
      continue;
    }

    if (incomingBuildNumber === existingBuildNumber) {
      existing.summary = uniqueLines([...existing.summary, ...entry.summary]);
    }
  }

  return Array.from(merged.values())
    .sort((left, right) => {
      const buildDelta = parseInteger(right.buildNumber, 0) - parseInteger(left.buildNumber, 0);
      if (buildDelta !== 0) {
        return buildDelta;
      }
      return String(right.publishedAt || '').localeCompare(String(left.publishedAt || ''));
    })
    .slice(0, 5)
    .map(({ buildNumber, ...entry }) => entry);
}

function buildCollection(policies, auditRows) {
  const betaChannels = policies
    .filter((policy) => policy.channel === 'beta')
    .map(buildOfficialSiteChannel);
  const stableChannels = policies
    .filter((policy) => policy.channel === 'stable')
    .map(buildOfficialSiteChannel);

  return {
    betaChannels,
    stableChannels,
    screenshots: {},
    releases: buildReleaseEntries(auditRows, policies),
    notes: [
      '官网版本说明现在直接读取 Cloudflare 中的版本策略。',
      '移动端与官网共用同一份版本元数据，不再依赖仓库内的 releases.json。'
    ]
  };
}

function buildFallbackCollection(env) {
  const fallbackPolicies = [
    buildFallbackPolicy('android', 'beta', env),
    buildFallbackPolicy('ios', 'beta', env),
    buildFallbackPolicy('android', 'stable', env),
    buildFallbackPolicy('ios', 'stable', env)
  ].filter((policy) => policy.enabled);

  return buildCollection(fallbackPolicies, []);
}

export async function handleOfficialSiteReleaseCollection(request, env, dbService) {
  const db = dbService.db || dbService;

  try {
    await ensureTables(db);
    const rows = await listStoredPolicies(db);
    const policies = rows.map((row) => serializePolicyRow(row, buildFallbackPolicy(row.platform, row.channel, env)));
    const auditRows = await listPolicyAuditRows(db);

    if (policies.length === 0) {
      return jsonResponse(buildFallbackCollection(env));
    }

    return jsonResponse(buildCollection(policies, auditRows));
  } catch (error) {
    console.warn('读取官网版本信息失败，回退环境变量:', error?.message || error);
    return jsonResponse(buildFallbackCollection(env));
  }
}
