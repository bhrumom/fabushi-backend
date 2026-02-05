import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';

// 获取排行榜
export async function handleGetLeaderboard(request, env, db) {
  try {
    // 尝试从缓存获取
    try {
      const cached = await env.USERS_KV.get('leaderboard:cache');
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < 5 * 60 * 1000) {
          return jsonResponse({ leaderboard: data, cached: true });
        }
      }
    } catch (cacheError) {
      console.error('缓存读取失败:', cacheError);
    }

    // 从数据库获取
    const leaderboard = await db.getLeaderboard(100);
    
    // 尝试缓存结果
    try {
      await env.USERS_KV.put('leaderboard:cache', JSON.stringify({
        data: leaderboard,
        timestamp: Date.now()
      }), { expirationTtl: 600 });
    } catch (cacheError) {
      console.error('缓存写入失败:', cacheError);
    }

    return jsonResponse({ leaderboard: leaderboard || [] });
  } catch (error) {
    console.error('获取排行榜失败:', error);
    return jsonResponse({ 
      error: '获取排行榜失败',
      message: error.message,
      leaderboard: [] 
    }, 200); // 返回200但带有错误信息和空数组
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

  return jsonResponse({ 
    message: '传输数据已更新',
    bytes
  });
}
