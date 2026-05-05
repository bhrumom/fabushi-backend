import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';

function asBool(value, fallback = false) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

async function getOptionalViewerUsername(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  try {
    const tokenData = await verifyToken(authHeader.substring(7), env);
    return tokenData?.username || null;
  } catch (error) {
    console.warn('排行榜可选认证失败，继续按游客返回:', error);
    return null;
  }
}

function mapPracticePrivacy(row) {
  return {
    isPrivate: asBool(row?.isPrivate ?? row?.is_private, false),
    showPracticeName: asBool(row?.showPracticeName ?? row?.show_practice_name, true),
    showDuration: asBool(row?.showDuration ?? row?.show_duration, true),
    showChantCount: asBool(row?.showChantCount ?? row?.show_chant_count, true),
  };
}

function applyPracticePrivacy(entry) {
  const privacy = mapPracticePrivacy(entry);
  const canShowDetails = !privacy.isPrivate;
  const showPracticeName = canShowDetails && privacy.showPracticeName;
  const showDuration = canShowDetails && privacy.showDuration;
  const showChantCount = canShowDetails && privacy.showChantCount;

  return {
    username: entry.username || 'Unknown',
    displayName: entry.nickname || entry.displayName || entry.username || 'Unknown',
    avatar: entry.avatar || entry.alipay_avatar || entry.wechat_headimgurl || null,
    totalBytes: entry.totalBytes || 0,
    totalRecords: privacy.isPrivate ? 0 : entry.totalRecords || 0,
    totalCount: showChantCount ? entry.totalCount || 0 : null,
    totalDuration: showDuration ? entry.totalDuration || 0 : null,
    totalDays: privacy.isPrivate ? 0 : entry.totalDays || 0,
    latestSutra: showPracticeName ? entry.latestSutra || null : null,
    latestRecordDate: privacy.isPrivate ? null : entry.latestRecordDate || null,
    latestPracticeAt: privacy.isPrivate ? null : entry.latestPracticeAt || null,
    followerCount: entry.followerCount || entry.follower_count || 0,
    followingCount: entry.followingCount || entry.following_count || 0,
    isFollowing: asBool(entry.isFollowing ?? entry.is_following, false),
    isSelf: asBool(entry.isSelf ?? entry.is_self, false),
    privacy,
  };
}

async function annotateGlobalSocial(db, entries, viewerUsername) {
  return await Promise.all((entries || []).map(async (entry) => {
    const username = entry.username || entry.user_id || entry.userId;
    if (!username) return entry;

    const row = await db.prepare(`
      SELECT
        u.nickname,
        u.avatar,
        u.alipay_avatar,
        u.wechat_headimgurl,
        (SELECT COUNT(*) FROM user_follows WHERE following_username = ?) as follower_count,
        (SELECT COUNT(*) FROM user_follows WHERE follower_username = ?) as following_count,
        EXISTS(
          SELECT 1 FROM user_follows
          WHERE follower_username = ? AND following_username = ?
        ) as is_following
      FROM users u
      WHERE u.username = ?
    `).bind(username, username, viewerUsername || '', username, username).first();

    return {
      ...entry,
      username,
      displayName: entry.displayName || entry.nickname || row?.nickname || username,
      avatar: entry.avatar || row?.avatar || row?.alipay_avatar || row?.wechat_headimgurl || null,
      followerCount: row?.follower_count || 0,
      followingCount: row?.following_count || 0,
      isFollowing: asBool(row?.is_following, false),
      isSelf: viewerUsername === username,
    };
  }));
}

// 获取全球布施数据量排行榜
export async function handleGetLeaderboard(request, env, db) {
  try {
    const url = new URL(request.url);
    const requestedLimit = parseInt(url.searchParams.get('limit') || '100');
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 100;
    const viewerUsername = await getOptionalViewerUsername(request, env);

    // 游客请求可使用缓存；登录请求需要叠加 isFollowing，不直接复用成品缓存。
    if (!viewerUsername) {
      try {
        const cached = await env.USERS_KV.get('leaderboard:cache:v2');
        if (cached) {
          const { data, timestamp } = JSON.parse(cached);
          if (Date.now() - timestamp < 5 * 60 * 1000) {
            return jsonResponse({ leaderboard: data.slice(0, limit), cached: true, type: 'global' });
          }
        }
      } catch (cacheError) {
        console.error('缓存读取失败:', cacheError);
      }
    }

    const rawLeaderboard = await db.getLeaderboard(limit);
    const leaderboard = await annotateGlobalSocial(db, rawLeaderboard || [], viewerUsername);

    if (!viewerUsername) {
      try {
        await env.USERS_KV.put('leaderboard:cache:v2', JSON.stringify({
          data: leaderboard,
          timestamp: Date.now()
        }), { expirationTtl: 600 });
      } catch (cacheError) {
        console.error('缓存写入失败:', cacheError);
      }
    }

    return jsonResponse({ leaderboard: leaderboard || [], type: 'global' });
  } catch (error) {
    console.error('获取排行榜失败:', error);
    return jsonResponse({
      error: '获取排行榜失败',
      message: error.message,
      leaderboard: []
    }, 200);
  }
}

// 获取禅室修行排行榜
export async function handleGetPracticeLeaderboard(request, env, db) {
  try {
    const url = new URL(request.url);
    const requestedLimit = parseInt(url.searchParams.get('limit') || '100');
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 100;
    const viewerUsername = await getOptionalViewerUsername(request, env);

    if (!viewerUsername) {
      try {
        const cached = await env.USERS_KV.get('leaderboard:practice:v4');
        if (cached) {
          const { data, timestamp } = JSON.parse(cached);
          if (Date.now() - timestamp < 5 * 60 * 1000) {
            return jsonResponse({ leaderboard: data.slice(0, limit), cached: true, type: 'practice' });
          }
        }
      } catch (cacheError) {
        console.error('缓存读取失败:', cacheError);
      }
    }

    const result = await db.prepare(`
      SELECT
        mr.username,
        u.nickname,
        u.avatar,
        u.alipay_avatar,
        u.wechat_headimgurl,
        COALESCE(u.total_transferred_bytes, 0) as totalBytes,
        COALESCE(pp.is_private, 0) as isPrivate,
        COALESCE(pp.show_practice_name, 1) as showPracticeName,
        COALESCE(pp.show_duration, 1) as showDuration,
        COALESCE(pp.show_chant_count, 1) as showChantCount,
        COUNT(*) as totalRecords,
        SUM(CASE WHEN mr.chant_count > 0 THEN mr.chant_count ELSE 1 END) as totalCount,
        SUM(COALESCE(mr.duration, 0)) as totalDuration,
        COUNT(DISTINCT mr.record_date) as totalDays,
        MAX(mr.record_date) as latestRecordDate,
        MAX(mr.created_at) as latestPracticeAt,
        (SELECT COUNT(*) FROM user_follows f WHERE f.following_username = mr.username) as followerCount,
        (SELECT COUNT(*) FROM user_follows f WHERE f.follower_username = mr.username) as followingCount,
        EXISTS(
          SELECT 1 FROM user_follows f
          WHERE f.follower_username = ? AND f.following_username = mr.username
        ) as isFollowing,
        CASE WHEN mr.username = ? THEN 1 ELSE 0 END as isSelf,
        (
          SELECT r2.sutra_name
          FROM meditation_records r2
          WHERE r2.username = mr.username
          ORDER BY r2.record_date DESC, r2.created_at DESC
          LIMIT 1
        ) as latestSutra
      FROM meditation_records mr
      JOIN users u ON mr.username = u.username
      LEFT JOIN user_practice_privacy pp ON pp.username = mr.username
      GROUP BY mr.username
      ORDER BY SUM(COALESCE(mr.duration, 0)) DESC, totalRecords DESC, latestPracticeAt DESC
      LIMIT ?
    `).bind(viewerUsername || '', viewerUsername || '', limit).all();

    const leaderboard = (result.results || []).map((entry, index) => ({
      ...applyPracticePrivacy(entry),
      rank: index + 1,
    }));

    if (!viewerUsername) {
      try {
        await env.USERS_KV.put('leaderboard:practice:v4', JSON.stringify({
          data: leaderboard,
          timestamp: Date.now()
        }), { expirationTtl: 600 });
      } catch (cacheError) {
        console.error('缓存写入失败:', cacheError);
      }
    }

    return jsonResponse({ leaderboard: leaderboard || [], type: 'practice' });
  } catch (error) {
    console.error('获取修行排行榜失败:', error);
    return jsonResponse({
      error: '获取修行排行榜失败',
      message: error.message,
      leaderboard: []
    }, 200);
  }
}

// 获取公开修行记录。心得/备注不返回，保持私密，并按用户隐私偏好裁剪字段。
export async function handleGetLeaderboardRecords(request, env, db) {
  try {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    const requestedLimit = parseInt(url.searchParams.get('limit') || '30');
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 30;

    if (!username) {
      return jsonResponse({ error: 'username required' }, 400);
    }

    const privacyRow = await db.prepare(`
      SELECT is_private, show_practice_name, show_duration, show_chant_count
      FROM user_practice_privacy
      WHERE username = ?
    `).bind(username).first();
    const privacy = mapPracticePrivacy(privacyRow);

    if (privacy.isPrivate) {
      return jsonResponse({ username, privacy, records: [] });
    }

    const result = await db.prepare(`
      SELECT id,
             CASE WHEN ? = 1 THEN sutra_name ELSE NULL END as sutra_name,
             CASE WHEN ? = 1 THEN sutra_source ELSE NULL END as sutra_source,
             CASE WHEN ? = 1 THEN duration ELSE NULL END as duration,
             CASE WHEN ? = 1 THEN chant_count ELSE NULL END as chant_count,
             record_date,
             local_time,
             timezone_offset_minutes,
             CASE WHEN ? = 1 THEN start_time ELSE NULL END as start_time,
             CASE WHEN ? = 1 THEN end_time ELSE NULL END as end_time,
             is_manual,
             created_at
      FROM meditation_records
      WHERE username = ?
      ORDER BY record_date DESC, created_at DESC
      LIMIT ?
    `).bind(
      privacy.showPracticeName ? 1 : 0,
      privacy.showPracticeName ? 1 : 0,
      privacy.showDuration ? 1 : 0,
      privacy.showChantCount ? 1 : 0,
      privacy.showDuration ? 1 : 0,
      privacy.showDuration ? 1 : 0,
      username,
      limit
    ).all();

    return jsonResponse({
      username,
      privacy,
      records: result.results || []
    });
  } catch (error) {
    console.error('获取公开修行记录失败:', error);
    return jsonResponse({ error: '获取公开修行记录失败' }, 500);
  }
}

// 更新传输数据
export async function handleUpdateTransferData(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) return jsonResponse({ error: '认证失败' }, 401);

  const { bytes } = await request.json();
  if (!bytes || bytes <= 0) {
    return jsonResponse({ error: '无效的字节数' }, 400);
  }

  await db.updateTransferData(tokenData.username, bytes);
  await env.USERS_KV.delete('leaderboard:cache');
  await env.USERS_KV.delete('leaderboard:cache:v2');
  await env.USERS_KV.delete('leaderboard:practice:v2');
  await env.USERS_KV.delete('leaderboard:practice:v3');
  await env.USERS_KV.delete('leaderboard:practice:v4');

  return jsonResponse({
    message: '传输数据已更新',
    bytes
  });
}
