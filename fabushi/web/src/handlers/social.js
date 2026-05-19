import { jsonResponse } from '../utils/response.js';
import {
  hasStableUserId,
  isMissingUserIdColumnError,
  requireAuthIdentity,
} from '../utils/auth-identity.js';

function normalizeBool(value, fallback = false) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

async function requireAuth(request, env, db) {
  const auth = await requireAuthIdentity(request, env, db);
  if (auth.error) return auth;
  await backfillSocialUserId(db, auth);
  return auth;
}

function mapPrivacy(row) {
  return {
    isPrivate: normalizeBool(row?.is_private, false),
    showPracticeName: normalizeBool(row?.show_practice_name, true),
    showDuration: normalizeBool(row?.show_duration, true),
    showChantCount: normalizeBool(row?.show_chant_count, true),
    updatedAt: row?.updated_at || null,
  };
}

function mapUser(row) {
  return {
    username: row.username,
    displayName: row.nickname || row.username,
    avatar: row.avatar || row.alipay_avatar || row.wechat_headimgurl || null,
    followerCount: row.follower_count || 0,
    followingCount: row.following_count || 0,
    isFollowing: normalizeBool(row.is_following, false),
    isSelf: normalizeBool(row.is_self, false),
  };
}

async function backfillSocialUserId(db, auth) {
  if (!hasStableUserId(auth)) return;
  const updates = [
    `UPDATE user_follows SET follower_user_id = ? WHERE follower_user_id IS NULL AND follower_username = ?`,
    `UPDATE user_follows SET following_user_id = ? WHERE following_user_id IS NULL AND following_username = ?`,
    `UPDATE user_practice_privacy SET user_id = ? WHERE user_id IS NULL AND username = ?`,
  ];

  await Promise.all(updates.map(async (sql) => {
    try {
      await db.prepare(sql).bind(auth.userId, auth.username).run();
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) {
        console.warn('social user_id backfill skipped:', error?.message || error);
      }
    }
  }));
}

async function getUserByUsername(db, username) {
  if (!username) return null;
  return await db.prepare(`
    SELECT id, username
    FROM users
    WHERE username = ?
  `).bind(username).first();
}

async function nextSyncVersion(db, auth) {
  if (hasStableUserId(auth)) {
    try {
      const row = await db.prepare(`
        SELECT COALESCE(MAX(sync_version), 0) + 1 as next_version FROM (
          SELECT MAX(sync_version) as sync_version FROM content_likes WHERE account_user_id = ? OR (account_user_id IS NULL AND username = ?)
          UNION ALL SELECT MAX(sync_version) as sync_version FROM comments WHERE account_user_id = ? OR (account_user_id IS NULL AND username = ?)
          UNION ALL SELECT MAX(sync_version) as sync_version FROM meditation_records WHERE user_id = ? OR (user_id IS NULL AND username = ?)
          UNION ALL SELECT MAX(sync_version) as sync_version FROM meditation_goals WHERE user_id = ? OR (user_id IS NULL AND username = ?)
          UNION ALL SELECT MAX(sync_version) as sync_version FROM user_follows WHERE follower_user_id = ? OR (follower_user_id IS NULL AND follower_username = ?)
        )
      `).bind(
        auth.userId, auth.username,
        auth.userId, auth.username,
        auth.userId, auth.username,
        auth.userId, auth.username,
        auth.userId, auth.username
      ).first();
      return row?.next_version || 1;
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) throw error;
    }
  }

  const row = await db.prepare(`
    SELECT COALESCE(MAX(sync_version), 0) + 1 as next_version FROM (
      SELECT MAX(sync_version) as sync_version FROM content_likes WHERE username = ?
      UNION ALL SELECT MAX(sync_version) as sync_version FROM comments WHERE username = ?
      UNION ALL SELECT MAX(sync_version) as sync_version FROM meditation_records WHERE username = ?
      UNION ALL SELECT MAX(sync_version) as sync_version FROM meditation_goals WHERE username = ?
      UNION ALL SELECT MAX(sync_version) as sync_version FROM user_follows WHERE follower_username = ?
    )
  `).bind(auth.username, auth.username, auth.username, auth.username, auth.username).first();
  return row?.next_version || 1;
}

async function findFollow(db, auth, target) {
  if (hasStableUserId(auth) && target?.id !== undefined && target?.id !== null) {
    try {
      return await db.prepare(`
        SELECT id
        FROM user_follows
        WHERE follower_user_id = ? AND following_user_id = ?
      `).bind(auth.userId, target.id).first();
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) throw error;
    }
  }

  return await db.prepare(`
    SELECT id
    FROM user_follows
    WHERE follower_username = ? AND following_username = ?
  `).bind(auth.username, target.username).first();
}

async function insertFollow(db, auth, target) {
  const now = new Date().toISOString();
  const syncVersion = await nextSyncVersion(db, auth);
  if (hasStableUserId(auth) && target?.id !== undefined && target?.id !== null) {
    try {
      return await db.prepare(`
        INSERT OR IGNORE INTO user_follows (
          follower_username, following_username, follower_user_id, following_user_id, sync_version, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(auth.username, target.username, auth.userId, target.id, syncVersion, now).run();
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) throw error;
    }
  }

  return await db.prepare(`
    INSERT OR IGNORE INTO user_follows (follower_username, following_username, sync_version, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(auth.username, target.username, syncVersion, now).run();
}

async function countFollowers(db, target) {
  if (target?.id !== undefined && target?.id !== null) {
    try {
      const row = await db.prepare(`
        SELECT COUNT(*) as follower_count
        FROM user_follows
        WHERE following_user_id = ? OR (following_user_id IS NULL AND following_username = ?)
      `).bind(target.id, target.username).first();
      return row?.follower_count || 0;
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) throw error;
    }
  }

  const row = await db.prepare(`
    SELECT COUNT(*) as follower_count
    FROM user_follows
    WHERE following_username = ?
  `).bind(target.username).first();
  return row?.follower_count || 0;
}

export async function handleToggleFollow(request, env, db) {
  const auth = await requireAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  try {
    const body = await request.json();
    const targetUsername = (body.username || body.targetUsername || '').toString().trim();
    if (!targetUsername) return jsonResponse({ success: false, error: 'username required' }, 400);
    if (targetUsername === auth.username) return jsonResponse({ success: false, error: 'cannot follow yourself' }, 400);

    const target = await getUserByUsername(db, targetUsername);
    if (!target) return jsonResponse({ success: false, error: 'user not found' }, 404);

    const existing = await findFollow(db, auth, target);
    let isFollowing = false;
    if (existing) {
      await db.prepare('DELETE FROM user_follows WHERE id = ?').bind(existing.id).run();
    } else {
      await insertFollow(db, auth, target);
      isFollowing = true;
    }

    return jsonResponse({
      success: true,
      username: targetUsername,
      isFollowing,
      followerCount: await countFollowers(db, target),
    });
  } catch (error) {
    console.error('toggle follow failed:', error);
    return jsonResponse({ success: false, error: 'toggle follow failed' }, 500);
  }
}

async function getFollowListRows(db, auth, username, type, limit, offset) {
  const target = await getUserByUsername(db, username);
  const byFollowers = type === 'followers';
  if (target?.id !== undefined && target?.id !== null) {
    try {
      const where = byFollowers
        ? `(f.following_user_id = ? OR (f.following_user_id IS NULL AND f.following_username = ?))`
        : `(f.follower_user_id = ? OR (f.follower_user_id IS NULL AND f.follower_username = ?))`;
      const join = byFollowers
        ? `u.id = f.follower_user_id OR (f.follower_user_id IS NULL AND u.username = f.follower_username)`
        : `u.id = f.following_user_id OR (f.following_user_id IS NULL AND u.username = f.following_username)`;

      return await db.prepare(`
        SELECT
          u.username,
          u.nickname,
          u.avatar,
          u.alipay_avatar,
          u.wechat_headimgurl,
          (SELECT COUNT(*) FROM user_follows ff WHERE ff.following_user_id = u.id OR (ff.following_user_id IS NULL AND ff.following_username = u.username)) as follower_count,
          (SELECT COUNT(*) FROM user_follows ff WHERE ff.follower_user_id = u.id OR (ff.follower_user_id IS NULL AND ff.follower_username = u.username)) as following_count,
          EXISTS(
            SELECT 1 FROM user_follows mine
            WHERE mine.follower_user_id = ? AND mine.following_user_id = u.id
          ) as is_following,
          CASE WHEN u.id = ? THEN 1 ELSE 0 END as is_self
        FROM user_follows f
        JOIN users u ON ${join}
        WHERE ${where}
        ORDER BY f.created_at DESC
        LIMIT ? OFFSET ?
      `).bind(auth.userId || -1, auth.userId || -1, target.id, target.username, limit, offset).all();
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) throw error;
    }
  }

  const whereColumn = byFollowers ? 'f.following_username' : 'f.follower_username';
  const userColumn = byFollowers ? 'f.follower_username' : 'f.following_username';
  return await db.prepare(`
    SELECT
      u.username,
      u.nickname,
      u.avatar,
      u.alipay_avatar,
      u.wechat_headimgurl,
      (SELECT COUNT(*) FROM user_follows ff WHERE ff.following_username = u.username) as follower_count,
      (SELECT COUNT(*) FROM user_follows ff WHERE ff.follower_username = u.username) as following_count,
      EXISTS(
        SELECT 1 FROM user_follows mine
        WHERE mine.follower_username = ? AND mine.following_username = u.username
      ) as is_following,
      CASE WHEN u.username = ? THEN 1 ELSE 0 END as is_self
    FROM user_follows f
    JOIN users u ON u.username = ${userColumn}
    WHERE ${whereColumn} = ?
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(auth.username, auth.username, username, limit, offset).all();
}

async function getFollowListTotal(db, username, type) {
  const target = await getUserByUsername(db, username);
  const column = type === 'followers' ? 'following' : 'follower';
  if (target?.id !== undefined && target?.id !== null) {
    try {
      const row = await db.prepare(`
        SELECT COUNT(*) as total
        FROM user_follows
        WHERE ${column}_user_id = ? OR (${column}_user_id IS NULL AND ${column}_username = ?)
      `).bind(target.id, target.username).first();
      return row?.total || 0;
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) throw error;
    }
  }

  const row = await db.prepare(`
    SELECT COUNT(*) as total
    FROM user_follows
    WHERE ${column}_username = ?
  `).bind(username).first();
  return row?.total || 0;
}

export async function handleGetFollowList(request, env, db) {
  const auth = await requireAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  try {
    const url = new URL(request.url);
    const type = url.searchParams.get('type') === 'followers' ? 'followers' : 'following';
    const username = (url.searchParams.get('username') || auth.username).trim();
    const requestedLimit = parseInt(url.searchParams.get('limit') || '50', 10);
    const requestedOffset = parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

    const rows = await getFollowListRows(db, auth, username, type, limit, offset);
    const total = await getFollowListTotal(db, username, type);

    return jsonResponse({
      success: true,
      type,
      username,
      total,
      users: (rows.results || []).map(mapUser),
    });
  } catch (error) {
    console.error('get follow list failed:', error);
    return jsonResponse({ success: false, error: 'get follow list failed' }, 500);
  }
}

export async function handleGetFollowSummary(request, env, db) {
  const auth = await requireAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  try {
    const url = new URL(request.url);
    const username = (url.searchParams.get('username') || auth.username).trim();
    const target = await getUserByUsername(db, username);

    if (target?.id !== undefined && target?.id !== null) {
      try {
        const row = await db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM user_follows WHERE following_user_id = ? OR (following_user_id IS NULL AND following_username = ?)) as follower_count,
            (SELECT COUNT(*) FROM user_follows WHERE follower_user_id = ? OR (follower_user_id IS NULL AND follower_username = ?)) as following_count,
            EXISTS(SELECT 1 FROM user_follows WHERE follower_user_id = ? AND following_user_id = ?) as is_following
        `).bind(target.id, username, target.id, username, auth.userId || -1, target.id).first();

        return jsonResponse({
          success: true,
          username,
          followerCount: row?.follower_count || 0,
          followingCount: row?.following_count || 0,
          isFollowing: normalizeBool(row?.is_following, false),
          isSelf: target.id === auth.userId,
        });
      } catch (error) {
        if (!isMissingUserIdColumnError(error)) throw error;
      }
    }

    const row = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM user_follows WHERE following_username = ?) as follower_count,
        (SELECT COUNT(*) FROM user_follows WHERE follower_username = ?) as following_count,
        EXISTS(SELECT 1 FROM user_follows WHERE follower_username = ? AND following_username = ?) as is_following
    `).bind(username, username, auth.username, username).first();

    return jsonResponse({
      success: true,
      username,
      followerCount: row?.follower_count || 0,
      followingCount: row?.following_count || 0,
      isFollowing: normalizeBool(row?.is_following, false),
      isSelf: username === auth.username,
    });
  } catch (error) {
    console.error('get follow summary failed:', error);
    return jsonResponse({ success: false, error: 'get follow summary failed' }, 500);
  }
}

export async function handleGetPracticePrivacy(request, env, db) {
  const auth = await requireAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  try {
    let row = null;
    if (hasStableUserId(auth)) {
      try {
        row = await db.prepare(`
          SELECT is_private, show_practice_name, show_duration, show_chant_count, updated_at
          FROM user_practice_privacy
          WHERE user_id = ? OR (user_id IS NULL AND username = ?)
        `).bind(auth.userId, auth.username).first();
      } catch (error) {
        if (!isMissingUserIdColumnError(error)) throw error;
      }
    }

    if (!row) {
      row = await db.prepare(`
        SELECT is_private, show_practice_name, show_duration, show_chant_count, updated_at
        FROM user_practice_privacy
        WHERE username = ?
      `).bind(auth.username).first();
    }

    return jsonResponse({ success: true, privacy: mapPrivacy(row) });
  } catch (error) {
    console.error('get practice privacy failed:', error);
    return jsonResponse({ success: false, error: 'get practice privacy failed' }, 500);
  }
}

async function upsertPracticePrivacy(db, auth, privacy, now) {
  if (hasStableUserId(auth)) {
    try {
      await db.prepare(`
        UPDATE user_practice_privacy
        SET username = ?,
            user_id = ?,
            is_private = ?,
            show_practice_name = ?,
            show_duration = ?,
            show_chant_count = ?,
            updated_at = ?
        WHERE user_id = ? OR username = ?
      `).bind(
        auth.username,
        auth.userId,
        privacy.is_private,
        privacy.show_practice_name,
        privacy.show_duration,
        privacy.show_chant_count,
        now,
        auth.userId,
        auth.username
      ).run();

      await db.prepare(`
        INSERT OR IGNORE INTO user_practice_privacy (
          username, user_id, is_private, show_practice_name, show_duration, show_chant_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        auth.username,
        auth.userId,
        privacy.is_private,
        privacy.show_practice_name,
        privacy.show_duration,
        privacy.show_chant_count,
        now
      ).run();
      return;
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) throw error;
    }
  }

  await db.prepare(`
    INSERT INTO user_practice_privacy (
      username, is_private, show_practice_name, show_duration, show_chant_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      is_private = excluded.is_private,
      show_practice_name = excluded.show_practice_name,
      show_duration = excluded.show_duration,
      show_chant_count = excluded.show_chant_count,
      updated_at = excluded.updated_at
  `).bind(
    auth.username,
    privacy.is_private,
    privacy.show_practice_name,
    privacy.show_duration,
    privacy.show_chant_count,
    now
  ).run();
}

export async function handleUpdatePracticePrivacy(request, env, db) {
  const auth = await requireAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  try {
    const body = await request.json();
    const privacy = {
      is_private: normalizeBool(body.isPrivate, false) ? 1 : 0,
      show_practice_name: normalizeBool(body.showPracticeName, true) ? 1 : 0,
      show_duration: normalizeBool(body.showDuration, true) ? 1 : 0,
      show_chant_count: normalizeBool(body.showChantCount, true) ? 1 : 0,
    };
    const now = new Date().toISOString();

    await upsertPracticePrivacy(db, auth, privacy, now);

    await Promise.allSettled([
      env.USERS_KV?.delete('leaderboard:practice:v3'),
      env.USERS_KV?.delete('leaderboard:practice:v4'),
    ]);

    return jsonResponse({
      success: true,
      privacy: mapPrivacy({ ...privacy, updated_at: now }),
    });
  } catch (error) {
    console.error('update practice privacy failed:', error);
    return jsonResponse({ success: false, error: 'update practice privacy failed' }, 500);
  }
}
