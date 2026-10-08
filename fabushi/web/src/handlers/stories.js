import { jsonResponse } from '../utils/response.js';
import { requireAuthIdentity } from '../utils/auth-identity.js';
import { hasUnlimitedUsage } from '../utils/helpers.js';

export const STORY_STEALTH_ACTIVE_MS = 25 * 60 * 1000;
export const STORY_STEALTH_COOLDOWN_MS = 3 * 60 * 60 * 1000;
export const STORY_STEALTH_RETROACTIVE_MS = 5 * 60 * 1000;
const MAX_STORY_ID_LENGTH = 200;
const MAX_STORY_REQUEST_ID_LENGTH = 200;
const MAX_REACTION_BYTES = 32;
const PRIVACY_KINDS = new Set(['everyone', 'contacts', 'closeFriends', 'selected']);

async function requireStableStoryAuth(request, env, db) {
  const auth = await requireAuthIdentity(request, env, db);
  if (auth.error) return auth;
  if (!Number.isFinite(auth.userId)) {
    return { error: '账号资料需要刷新后才能使用 Story', status: 409 };
  }
  return auth;
}

export async function storyActorIdFromAccountId(accountId) {
  const bytes = new TextEncoder().encode(String(accountId));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const fingerprint = [...digest.slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `human:account:${fingerprint}`;
}

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function finiteInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function normalizeActorIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))].sort();
}

export function normalizeStoryForServer(story, actorId) {
  if (!story || typeof story !== 'object') throw new Error('Story payload invalid');
  const idValue = typeof story.id === 'object' && story.id !== null ? story.id[0] ?? story.id.value : story.id;
  const id = String(idValue ?? '').trim();
  if (!id || id.length > MAX_STORY_ID_LENGTH) throw new Error('Story id invalid');
  const media = story.media;
  if (!media || typeof media !== 'object' || !String(media.id || '').trim()) {
    throw new Error('Story media invalid');
  }
  const createdAtMs = finiteInt(story.createdAtMs, -1);
  const expiresAtMs = finiteInt(story.expiresAtMs, -1);
  if (createdAtMs < 0 || expiresAtMs <= createdAtMs) throw new Error('Story lifetime invalid');
  const privacy = story.privacy && typeof story.privacy === 'object' ? story.privacy : {};
  const kind = String(privacy.kind || '');
  if (!PRIVACY_KINDS.has(kind)) throw new Error('Story privacy invalid');
  const caption = story.caption && typeof story.caption === 'object'
    ? story.caption
    : { text: String(story.caption || ''), entities: [] };
  return {
    id,
    ownerId: actorId,
    media,
    caption: {
      text: String(caption.text || ''),
      entities: Array.isArray(caption.entities) ? caption.entities : [],
    },
    privacy: {
      kind,
      includedActorIds: normalizeActorIds(privacy.includedActorIds),
      excludedActorIds: normalizeActorIds(privacy.excludedActorIds),
    },
    createdAtMs,
    expiresAtMs,
    editedAtMs: story.editedAtMs == null ? null : finiteInt(story.editedAtMs, null),
    pinnedToProfile: story.pinnedToProfile === true,
    protectedContent: story.protectedContent === true,
    allowReplies: story.allowReplies !== false,
    views: {},
    anonymousViewCount: 0,
  };
}

async function loadUserForEntitlement(db, auth) {
  return await db.prepare(`
    SELECT id, username, email, membership_type, membership_expires_at, free_trial_end_date
    FROM users
    WHERE id = ?
    LIMIT 1
  `).bind(auth.userId).first();
}

export async function storyStealthEntitled(db, auth, env, nowMs = Date.now()) {
  const user = await loadUserForEntitlement(db, auth);
  if (!user) return false;
  if (hasUnlimitedUsage(user, env)) return true;
  if (String(user.membership_type || '').toLowerCase() === 'lifetime') return true;
  const candidates = [user.membership_expires_at, user.free_trial_end_date]
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return candidates.some((expiry) => expiry > nowMs);
}

async function loadStealthRow(db, userId) {
  return await db.prepare(`
    SELECT user_id, enabled_till_ms, cooldown_till_ms, last_activation_request_id, updated_at_ms
    FROM story_stealth
    WHERE user_id = ?
    LIMIT 1
  `).bind(userId).first();
}

function stealthPayload(row, entitled) {
  return {
    entitled,
    state: {
      enabledTillMs: finiteInt(row?.enabled_till_ms, 0),
      cooldownTillMs: finiteInt(row?.cooldown_till_ms, 0),
      lastActivationRequestId: row?.last_activation_request_id ?? null,
    },
  };
}

export async function getStoryStealthForAuth(db, auth, env, nowMs = Date.now()) {
  const [row, entitled] = await Promise.all([
    loadStealthRow(db, auth.userId),
    storyStealthEntitled(db, auth, env, nowMs),
  ]);
  return stealthPayload(row, entitled);
}

async function anonymizeRecentStoryViews(db, userId, sinceMs) {
  const rows = await db.prepare(`
    SELECT story_id, COUNT(*) AS removed_count
    FROM story_views
    WHERE viewer_user_id = ? AND viewed_at_ms >= ?
    GROUP BY story_id
  `).bind(userId, sinceMs).all();
  const affected = rows.results || [];
  if (affected.length === 0) return 0;
  await db.prepare(`
    DELETE FROM story_views
    WHERE viewer_user_id = ? AND viewed_at_ms >= ?
  `).bind(userId, sinceMs).run();
  let removed = 0;
  for (const row of affected) {
    const count = Math.max(0, finiteInt(row.removed_count, 0));
    if (!count) continue;
    removed += count;
    await db.prepare(`
      UPDATE stories
      SET anonymous_view_count = anonymous_view_count + ?
      WHERE id = ?
    `).bind(count, row.story_id).run();
  }
  return removed;
}

export async function activateStoryStealthForAuth(
  db,
  auth,
  env,
  { requestId, nowMs = Date.now() },
) {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId || normalizedRequestId.length > MAX_STORY_REQUEST_ID_LENGTH) {
    return { status: 400, payload: { success: false, error: 'Story stealth request id invalid' } };
  }

  const current = await loadStealthRow(db, auth.userId);
  const entitled = await storyStealthEntitled(db, auth, env, nowMs);
  if (current?.last_activation_request_id === normalizedRequestId
      || finiteInt(current?.enabled_till_ms, 0) > nowMs) {
    return {
      status: 200,
      payload: { success: true, deduplicated: true, ...stealthPayload(current, entitled) },
    };
  }
  if (finiteInt(current?.cooldown_till_ms, 0) > nowMs) {
    return {
      status: 409,
      payload: {
        success: false,
        error: 'Story stealth cooling down',
        retryAtMs: finiteInt(current.cooldown_till_ms, 0),
        ...stealthPayload(current, entitled),
      },
    };
  }
  if (!entitled) {
    return {
      status: 403,
      payload: { success: false, error: 'Story stealth entitlement required', ...stealthPayload(current, false) },
    };
  }

  await db.prepare(`
    INSERT INTO story_stealth (
      user_id, enabled_till_ms, cooldown_till_ms,
      last_activation_request_id, updated_at_ms
    ) VALUES (?, 0, 0, NULL, ?)
    ON CONFLICT(user_id) DO NOTHING
  `).bind(auth.userId, nowMs).run();

  const enabledTillMs = nowMs + STORY_STEALTH_ACTIVE_MS;
  const cooldownTillMs = nowMs + STORY_STEALTH_COOLDOWN_MS;
  const updated = await db.prepare(`
    UPDATE story_stealth
    SET enabled_till_ms = ?,
        cooldown_till_ms = ?,
        last_activation_request_id = ?,
        updated_at_ms = ?
    WHERE user_id = ?
      AND enabled_till_ms <= ?
      AND cooldown_till_ms <= ?
  `).bind(
    enabledTillMs,
    cooldownTillMs,
    normalizedRequestId,
    nowMs,
    auth.userId,
    nowMs,
    nowMs,
  ).run();

  if (updated.meta?.changes === 0) {
    const raced = await loadStealthRow(db, auth.userId);
    const duplicate = raced?.last_activation_request_id === normalizedRequestId;
    return {
      status: duplicate || finiteInt(raced?.enabled_till_ms, 0) > nowMs ? 200 : 409,
      payload: {
        success: duplicate || finiteInt(raced?.enabled_till_ms, 0) > nowMs,
        deduplicated: true,
        ...(duplicate || finiteInt(raced?.enabled_till_ms, 0) > nowMs
          ? {}
          : { error: 'Story stealth cooling down', retryAtMs: finiteInt(raced?.cooldown_till_ms, 0) }),
        ...stealthPayload(raced, entitled),
      },
    };
  }

  const anonymizedRecentViews = await anonymizeRecentStoryViews(
    db,
    auth.userId,
    nowMs - STORY_STEALTH_RETROACTIVE_MS,
  );
  const row = await loadStealthRow(db, auth.userId);
  return {
    status: 200,
    payload: {
      success: true,
      deduplicated: false,
      anonymizedRecentViews,
      ...stealthPayload(row, true),
    },
  };
}

function parseStoryRow(row) {
  const story = parseJson(row.story_json, null);
  if (!story || typeof story !== 'object') return null;
  return {
    ...story,
    anonymousViewCount: Math.max(0, finiteInt(row.anonymous_view_count, 0)),
  };
}

async function areFriends(db, firstUserId, secondUserId) {
  const row = await db.prepare(`
    SELECT id
    FROM friend_requests
    WHERE status = 'accepted'
      AND ((sender_user_id = ? AND recipient_user_id = ?)
        OR (sender_user_id = ? AND recipient_user_id = ?))
    LIMIT 1
  `).bind(firstUserId, secondUserId, secondUserId, firstUserId).first();
  return Boolean(row);
}

async function storyVisibleTo(db, row, auth, viewerActorId) {
  if (row.owner_user_id === auth.userId) return true;
  const story = parseStoryRow(row);
  if (!story) return false;
  const privacy = story.privacy || {};
  const included = new Set(normalizeActorIds(privacy.includedActorIds));
  const excluded = new Set(normalizeActorIds(privacy.excludedActorIds));
  if (excluded.has(viewerActorId)) return false;
  if (included.has(viewerActorId)) return true;
  if (privacy.kind === 'everyone') return true;
  if (privacy.kind === 'contacts') return await areFriends(db, auth.userId, row.owner_user_id);
  // Close-friend membership does not yet have a canonical server table.
  // Explicit inclusion remains authoritative; otherwise fail closed.
  return false;
}

async function loadViewsForStory(db, storyId, auth, ownerUserId) {
  const rows = await db.prepare(`
    SELECT viewer_user_id, viewer_actor_id, viewed_at_ms, reaction, forwarded
    FROM story_views
    WHERE story_id = ?
      AND (? = ? OR viewer_user_id = ?)
    ORDER BY viewed_at_ms ASC
  `).bind(storyId, auth.userId, ownerUserId, auth.userId).all();
  const views = {};
  for (const row of rows.results || []) {
    views[row.viewer_actor_id] = {
      actorId: row.viewer_actor_id,
      viewedAtMs: finiteInt(row.viewed_at_ms, 0),
      reaction: row.reaction ?? null,
      forwarded: row.forwarded === 1,
    };
  }
  return views;
}

async function projectStory(db, row, auth) {
  const story = parseStoryRow(row);
  if (!story) return null;
  const actorId = await storyActorIdFromAccountId(auth.userId);
  story.views = await loadViewsForStory(db, row.id, auth, row.owner_user_id);
  story.canDelete = row.owner_user_id === auth.userId;
  story.myReaction = story.views[actorId]?.reaction ?? null;
  return story;
}

async function loadStoryRow(db, storyId) {
  return await db.prepare(`
    SELECT id, owner_user_id, owner_username, story_json, expires_at_ms,
      pinned_to_profile, anonymous_view_count
    FROM stories
    WHERE id = ?
    LIMIT 1
  `).bind(storyId).first();
}

export async function publishStoryForAuth(db, auth, story) {
  const actorId = await storyActorIdFromAccountId(auth.userId);
  let canonical;
  try {
    canonical = normalizeStoryForServer(story, actorId);
  } catch (error) {
    return { status: 400, payload: { success: false, error: error.message } };
  }
  const existing = await loadStoryRow(db, canonical.id);
  if (existing && existing.owner_user_id !== auth.userId) {
    return { status: 409, payload: { success: false, error: 'Story id already belongs to another account' } };
  }
  await db.prepare(`
    INSERT INTO stories (
      id, owner_user_id, owner_username, story_json, created_at_ms, expires_at_ms,
      pinned_to_profile, protected_content, allow_replies, anonymous_view_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      story_json = excluded.story_json,
      expires_at_ms = excluded.expires_at_ms,
      pinned_to_profile = excluded.pinned_to_profile,
      protected_content = excluded.protected_content,
      allow_replies = excluded.allow_replies
    WHERE stories.owner_user_id = excluded.owner_user_id
  `).bind(
    canonical.id,
    auth.userId,
    auth.username,
    JSON.stringify(canonical),
    canonical.createdAtMs,
    canonical.expiresAtMs,
    canonical.pinnedToProfile ? 1 : 0,
    canonical.protectedContent ? 1 : 0,
    canonical.allowReplies ? 1 : 0,
  ).run();
  const row = await loadStoryRow(db, canonical.id);
  return { status: 201, payload: { success: true, story: await projectStory(db, row, auth) } };
}

export async function listStoriesForAuth(db, auth, nowMs = Date.now()) {
  const viewerActorId = await storyActorIdFromAccountId(auth.userId);
  const rows = await db.prepare(`
    SELECT id, owner_user_id, owner_username, story_json, expires_at_ms,
      pinned_to_profile, anonymous_view_count
    FROM stories
    WHERE expires_at_ms >= ? OR pinned_to_profile = 1
    ORDER BY created_at_ms DESC, id ASC
    LIMIT 200
  `).bind(nowMs).all();
  const stories = [];
  for (const row of rows.results || []) {
    if (!(await storyVisibleTo(db, row, auth, viewerActorId))) continue;
    const story = await projectStory(db, row, auth);
    if (story) stories.push(story);
  }
  return stories;
}

export async function viewStoryForAuth(db, auth, storyId, nowMs = Date.now()) {
  const row = await loadStoryRow(db, storyId);
  if (!row) return { status: 404, payload: { success: false, error: 'Story not found' } };
  const actorId = await storyActorIdFromAccountId(auth.userId);
  if (!(await storyVisibleTo(db, row, auth, actorId))) {
    return { status: 403, payload: { success: false, error: 'Story permission denied' } };
  }
  if (row.pinned_to_profile !== 1 && finiteInt(row.expires_at_ms, 0) < nowMs) {
    return { status: 410, payload: { success: false, error: 'Story expired' } };
  }
  const stealth = await loadStealthRow(db, auth.userId);
  if (finiteInt(stealth?.enabled_till_ms, 0) > nowMs) {
    await db.prepare(`
      UPDATE stories
      SET anonymous_view_count = anonymous_view_count + 1
      WHERE id = ?
    `).bind(storyId).run();
  } else {
    await db.prepare(`
      INSERT INTO story_views (
        story_id, viewer_user_id, viewer_actor_id, viewed_at_ms, reaction, forwarded
      ) VALUES (?, ?, ?, ?, NULL, 0)
      ON CONFLICT(story_id, viewer_user_id) DO UPDATE SET
        viewed_at_ms = MIN(story_views.viewed_at_ms, excluded.viewed_at_ms)
    `).bind(storyId, auth.userId, actorId, nowMs).run();
  }
  return {
    status: 200,
    payload: { success: true, story: await projectStory(db, await loadStoryRow(db, storyId), auth) },
  };
}

export async function reactStoryForAuth(db, auth, storyId, reaction, nowMs = Date.now()) {
  const row = await loadStoryRow(db, storyId);
  if (!row) return { status: 404, payload: { success: false, error: 'Story not found' } };
  const actorId = await storyActorIdFromAccountId(auth.userId);
  if (!(await storyVisibleTo(db, row, auth, actorId))) {
    return { status: 403, payload: { success: false, error: 'Story permission denied' } };
  }
  if (row.pinned_to_profile !== 1 && finiteInt(row.expires_at_ms, 0) < nowMs) {
    return { status: 410, payload: { success: false, error: 'Story expired' } };
  }
  const normalized = reaction == null ? null : String(reaction).trim();
  if (normalized != null && new TextEncoder().encode(normalized).byteLength > MAX_REACTION_BYTES) {
    return { status: 400, payload: { success: false, error: 'Story reaction invalid' } };
  }
  const existing = await db.prepare(`
    SELECT viewer_user_id
    FROM story_views
    WHERE story_id = ? AND viewer_user_id = ?
    LIMIT 1
  `).bind(storyId, auth.userId).first();
  if (!existing && normalized == null) {
    return {
      status: 200,
      payload: { success: true, story: await projectStory(db, row, auth) },
    };
  }
  await db.prepare(`
    INSERT INTO story_views (
      story_id, viewer_user_id, viewer_actor_id, viewed_at_ms, reaction, forwarded
    ) VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(story_id, viewer_user_id) DO UPDATE SET
      reaction = excluded.reaction
  `).bind(storyId, auth.userId, actorId, nowMs, normalized).run();
  return {
    status: 200,
    payload: { success: true, story: await projectStory(db, await loadStoryRow(db, storyId), auth) },
  };
}

export async function deleteStoryForAuth(db, auth, storyId) {
  const row = await loadStoryRow(db, storyId);
  if (!row) return { status: 404, payload: { success: false, error: 'Story not found' } };
  if (row.owner_user_id !== auth.userId) {
    return { status: 403, payload: { success: false, error: 'Story permission denied' } };
  }
  await db.prepare('DELETE FROM stories WHERE id = ? AND owner_user_id = ?')
    .bind(storyId, auth.userId)
    .run();
  return { status: 200, payload: { success: true, storyId } };
}

export async function handleGetStoryStealth(request, env, db) {
  const auth = await requireStableStoryAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const payload = await getStoryStealthForAuth(db, auth, env);
  return jsonResponse({ success: true, ...payload });
}

export async function handleActivateStoryStealth(request, env, db) {
  const auth = await requireStableStoryAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const body = await request.json();
  const result = await activateStoryStealthForAuth(db, auth, env, {
    requestId: body.requestId ?? body.clientRequestId,
    nowMs: Date.now(),
  });
  return jsonResponse(result.payload, result.status);
}

export async function handlePublishStory(request, env, db) {
  const auth = await requireStableStoryAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const body = await request.json();
  const result = await publishStoryForAuth(db, auth, body.story ?? body);
  return jsonResponse(result.payload, result.status);
}

export async function handleListStories(request, env, db) {
  const auth = await requireStableStoryAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  return jsonResponse({ success: true, stories: await listStoriesForAuth(db, auth) });
}

export async function handleViewStory(request, env, db, storyId) {
  const auth = await requireStableStoryAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const result = await viewStoryForAuth(db, auth, decodeURIComponent(storyId));
  return jsonResponse(result.payload, result.status);
}

export async function handleReactStory(request, env, db, storyId) {
  const auth = await requireStableStoryAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const body = await request.json();
  const result = await reactStoryForAuth(
    db,
    auth,
    decodeURIComponent(storyId),
    body.reaction ?? null,
  );
  return jsonResponse(result.payload, result.status);
}

export async function handleDeleteStory(request, env, db, storyId) {
  const auth = await requireStableStoryAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const result = await deleteStoryForAuth(db, auth, decodeURIComponent(storyId));
  return jsonResponse(result.payload, result.status);
}
