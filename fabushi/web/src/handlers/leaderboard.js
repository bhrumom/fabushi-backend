import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';

// 获取排行榜
export async function handleGetLeaderboard(request, env, db) {
  try {
    const url = new URL(request.url);
    const requestedLimit = parseInt(url.searchParams.get('limit') || '100');
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 100;

    // 尝试从缓存获取
    try {
      const cached = await env.USERS_KV.get('leaderboard:practice:v2');
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < 5 * 60 * 1000) {
          return jsonResponse({ leaderboard: data.slice(0, limit), cached: true, type: 'practice' });
        }
      }
    } catch (cacheError) {
      console.error('缓存读取失败:', cacheError);
    }

    const result = await db.prepare(`
      SELECT
        mr.username,
        u.nickname,
        u.avatar,
        u.alipay_avatar,
        u.wechat_headimgurl,
        COALESCE(u.total_transferred_bytes, 0) as totalBytes,
        COUNT(*) as totalRecords,
        SUM(CASE WHEN mr.chant_count > 0 THEN mr.chant_count ELSE 1 END) as totalCount,
        SUM(COALESCE(mr.duration, 0)) as totalDuration,
        COUNT(DISTINCT mr.record_date) as totalDays,
        MAX(mr.record_date) as latestRecordDate,
        MAX(mr.created_at) as latestPracticeAt,
        (
          SELECT r2.sutra_name
          FROM meditation_records r2
          WHERE r2.username = mr.username
          ORDER BY r2.record_date DESC, r2.created_at DESC
          LIMIT 1
        ) as latestSutra
      FROM meditation_records mr
      LEFT JOIN users u ON mr.username = u.username
      GROUP BY mr.username
      ORDER BY totalCount DESC, totalDuration DESC, latestPracticeAt DESC
      LIMIT ?
    `).bind(limit).all();

    const leaderboard = (result.results || []).map((entry, index) => ({
      username: entry.username || 'Unknown',
      displayName: entry.nickname || entry.username || 'Unknown',
      avatar: entry.avatar || entry.alipay_avatar || entry.wechat_headimgurl || null,
      totalBytes: entry.totalBytes || 0,
      totalRecords: entry.totalRecords || 0,
      totalCount: entry.totalCount || 0,
      totalDuration: entry.totalDuration || 0,
      totalDays: entry.totalDays || 0,
      latestSutra: entry.latestSutra || null,
      latestRecordDate: entry.latestRecordDate || null,
      latestPracticeAt: entry.latestPracticeAt || null,
      rank: index + 1
    }));
    
    // 尝试缓存结果
    try {
      await env.USERS_KV.put('leaderboard:practice:v2', JSON.stringify({
        data: leaderboard,
        timestamp: Date.now()
      }), { expirationTtl: 600 });
    } catch (cacheError) {
      console.error('缓存写入失败:', cacheError);
    }

    return jsonResponse({ leaderboard: leaderboard || [], type: 'practice' });
  } catch (error) {
    console.error('获取排行榜失败:', error);
    return jsonResponse({ 
      error: '获取排行榜失败',
      message: error.message,
      leaderboard: [] 
    }, 200); // 返回200但带有错误信息和空数组
  }
}

// 获取公开修行记录。心得/备注不返回，保持私密。
export async function handleGetLeaderboardRecords(request, env, db) {
  try {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    const requestedLimit = parseInt(url.searchParams.get('limit') || '30');
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 30;

    if (!username) {
      return jsonResponse({ error: 'username required' }, 400);
    }

    const result = await db.prepare(`
      SELECT id, sutra_name, sutra_source, duration, chant_count, record_date, is_manual, created_at
      FROM meditation_records
      WHERE username = ?
      ORDER BY record_date DESC, created_at DESC
      LIMIT ?
    `).bind(username, limit).all();

    return jsonResponse({
      username,
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
  await env.USERS_KV.delete('leaderboard:practice:v2');

  return jsonResponse({ 
    message: '传输数据已更新',
    bytes
  });
}
