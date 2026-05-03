import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';

function normalizeBool(value, fallback = false) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

async function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: '未提供认证信息', status: 401 };
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData?.username) {
    return { error: '认证失败', status: 401 };
  }

  return { username: tokenData.username };
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

async function nextSyncVersion(db, username) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(sync_version), 0) + 1 as next_version FROM (
      SELECT MAX(sync_version) as sync_version FROM content_likes WHERE username = ?
      UNION ALL SELECT MAX(sync_version) as sync_version FROM comments WHERE username = ?
      UNION ALL SELECT MAX(sync_version) as sync_version FROM meditation_records WHERE username = ?
      UNION ALL SELECT MAX(sync_version) as sync_version FROM meditation_goals WHERE username = ?
      UNION ALL SELECT MAX(sync_version) as sync_version FROM user_follows WHERE follower_username = ?
    )
  `).bind(username, username, username, username, username).first();
  return row?.next_version || 1;
}

export async function handleToggleFollow(request, env, db) {
  const auth = await requireAuth(request, env);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  try {
    const body = await request.json();
    const targetUsername = (body.username || body.targetUsername || '').toString().trim();
    if (!targetUsername) return jsonResponse({ success: false, error: 'username required' }, 400);
    if (targetUsername === auth.username) return jsonResponse({ success: false, error: '不能关注自己' }, 400);

    const user = await db.prepare('SELECT username FROM users WHERE username = ?').bind(targetUsername).first();
    if (!user) return jsonResponse({ success: false, error: '用户不存在' }, 404);

    const existing = await db.prepare(`
      SELECT id FROM user_follows WHERE follower_username = ? AND following_username = ?
    `).bind(auth.username, targetUsername).first();

    let isFollowing = false;
    if (existing) {
      await db.prepare('DELETE FROM user_follows WHERE id = ?').bind(existing.id).run();
    } else {
      await db.prepare(`
        INSERT INTO user_follows (follower_username, following_username, sync_version, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(auth.username, targetUsername, await nextSyncVersion(db, auth.username), new Date().toISOString()).run();
      isFollowing = true;
    }

    const followerRow = await db.prepare(`
      SELECT COUNT(*) as follower_count FROM user_follows WHERE following_username = ?
    `).bind(targetUsername).first();

    return jsonResponse({
      success: true,
      username: targetUsername,
      isFollowing,
      followerCount: followerRow?.follower_count || 0,
    });
  } catch (error) {
    console.error('切换关注失败:', error);
    return jsonResponse({ success: false, error: '切换关注失败' }, 500);
  }
}

export async function handleGetFollowList(request, env, db) {
  const auth = await requireAuth(request, env);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  try {
    const url = new URL(request.url);
    const type = url.searchParams.get('type') === 'followers' ? 'followers' : 'following';
    const username = (url.searchParams.get('username') || auth.username).trim();
    const requestedLimit = parseInt(url.searchParams.get('limit') || '50', 10);
    const requestedOffset = parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

    const whereColumn = type === 'followers' ? 'f.following_username' : 'f.follower_username';
    const userColumn = type === 'followers' ? 'f.follower_username' : 'f.following_username';

    const rows = await db.prepare(`
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

    const countRow = await db.prepare(`
      SELECT COUNT(*) as total FROM user_follows f WHERE ${whereColumn} = ?
    `).bind(username).first();

    return jsonResponse({
      success: true,
      type,
      username,
      total: countRow?.total || 0,
      users: (rows.results || []).map(mapUser),
    });
  } catch (error) {
    console.error('获取关注列表失败:', error);
    return jsonResponse({ success: false, error: '获取关注列表失败' }, 500);
  }
}

export async function handleGetFollowSummary(request, env, db) {
  const auth = await requireAuth(request, env);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  try {
    const url = new URL(request.url);
    const username = (url.searchParams.get('username') || auth.username).trim();
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
    console.error('获取关注统计失败:', error);
    return jsonResponse({ success: false, error: '获取关注统计失败' }, 500);
  }
}

export async function handleGetPracticePrivacy(request, env, db) {
  const auth = await requireAuth(request, env);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  try {
    const row = await db.prepare(`
      SELECT is_private, show_practice_name, show_duration, show_chant_count, updated_at
      FROM user_practice_privacy
      WHERE username = ?
    `).bind(auth.username).first();

    return jsonResponse({ success: true, privacy: mapPrivacy(row) });
  } catch (error) {
    console.error('获取修行隐私设置失败:', error);
    return jsonResponse({ success: false, error: '获取修行隐私设置失败' }, 500);
  }
}

export async function handleUpdatePracticePrivacy(request, env, db) {
  const auth = await requireAuth(request, env);
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

    await Promise.allSettled([
      env.USERS_KV?.delete('leaderboard:practice:v3'),
      env.USERS_KV?.delete('leaderboard:practice:v4'),
    ]);

    return jsonResponse({
      success: true,
      privacy: mapPrivacy({ ...privacy, updated_at: now }),
    });
  } catch (error) {
    console.error('更新修行隐私设置失败:', error);
    return jsonResponse({ success: false, error: '更新修行隐私设置失败' }, 500);
  }
}
