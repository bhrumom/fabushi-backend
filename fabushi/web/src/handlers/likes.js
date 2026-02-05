import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';

export async function handleToggleLike(request, env, db) {
    try {
        const authHeader = request.headers.get('Authorization');
        const token = authHeader?.replace('Bearer ', '');

        // 验证 token 获取用户信息
        let userId = null;
        if (token) {
            const decoded = await verifyToken(token, env);
            userId = decoded?.username || null;
        }

        const { contentId, contentType, action, title, filePath } = await request.json();

        if (!contentId || !contentType) {
            return jsonResponse({ error: '缺少必要参数' }, 400);
        }

        if (action === 'like') {
            // 点赞时保存内容元数据（标题和文件路径）
            await db.prepare(
                'INSERT OR IGNORE INTO content_likes (content_id, content_type, username, title, file_path, created_at, sync_version) VALUES (?, ?, ?, ?, ?, ?, 1)'
            ).bind(contentId, contentType, userId, title || null, filePath || null, new Date().toISOString()).run();

            // 同步更新统一的 content_metadata 表
            await db.prepare(`
                INSERT INTO content_metadata (content_id, content_type, title, file_path, like_count, comment_count)
                VALUES (?, ?, ?, ?, 1, 0)
                ON CONFLICT(content_id) DO UPDATE SET 
                  title = COALESCE(excluded.title, title),
                  file_path = COALESCE(excluded.file_path, file_path),
                  like_count = like_count + 1
            `).bind(contentId, contentType, title || null, filePath || null).run();
        } else if (action === 'unlike') {
            if (userId) {
                await db.prepare('DELETE FROM content_likes WHERE content_id = ? AND username = ?')
                    .bind(contentId, userId).run();
            } else {
                await db.prepare('DELETE FROM content_likes WHERE content_id = ? AND username IS NULL')
                    .bind(contentId).run();
            }

            // 更新 content_metadata 的 like_count
            await db.prepare(`
                UPDATE content_metadata SET like_count = MAX(0, like_count - 1) WHERE content_id = ?
            `).bind(contentId).run();
        }

        const result = await db.prepare(
            'SELECT COUNT(*) as count FROM content_likes WHERE content_id = ?'
        ).bind(contentId).first();

        return jsonResponse({ success: true, likeCount: result.count });
    } catch (error) {
        console.error('Toggle like error:', error);
        return jsonResponse({ error: '操作失败' }, 500);
    }
}

export async function handleGetLikeCount(request, env, db) {
    try {
        const url = new URL(request.url);
        const contentId = url.searchParams.get('contentId');

        if (!contentId) {
            return jsonResponse({ error: '缺少contentId参数' }, 400);
        }

        const result = await db.prepare(
            'SELECT COUNT(*) as count FROM content_likes WHERE content_id = ?'
        ).bind(contentId).first();

        return jsonResponse({ likeCount: result.count || 0 });
    } catch (error) {
        console.error('Get like count error:', error);
        return jsonResponse({ error: '获取失败' }, 500);
    }
}

export async function handleBatchGetLikeCounts(request, env, db) {
    try {
        const { contentIds } = await request.json();

        if (!contentIds || !Array.isArray(contentIds)) {
            return jsonResponse({ error: '缺少contentIds参数' }, 400);
        }

        const placeholders = contentIds.map(() => '?').join(',');
        const results = await db.prepare(
            `SELECT content_id, COUNT(*) as count FROM content_likes WHERE content_id IN (${placeholders}) GROUP BY content_id`
        ).bind(...contentIds).all();

        const likeCounts = {};
        results.results.forEach(row => {
            likeCounts[row.content_id] = row.count;
        });

        return jsonResponse({ likeCounts });
    } catch (error) {
        console.error('Batch get like counts error:', error);
        return jsonResponse({ error: '获取失败' }, 500);
    }
}

export async function handleGetMyLikes(request, env, db) {
    try {
        const authHeader = request.headers.get('Authorization');
        const token = authHeader?.replace('Bearer ', '');

        if (!token) {
            return jsonResponse({ error: '未登录' }, 401);
        }

        const decoded = await verifyToken(token, env);
        if (!decoded?.username) {
            return jsonResponse({ error: '无效的token' }, 401);
        }

        const results = await db.prepare(
            'SELECT content_id as id, content_type as contentType, title, file_path as filePath, created_at as likedAt FROM content_likes WHERE username = ? ORDER BY created_at DESC'
        ).bind(decoded.username).all();

        return jsonResponse({ success: true, likes: results.results });
    } catch (error) {
        console.error('Get my likes error:', error);
        return jsonResponse({ error: '获取失败' }, 500);
    }
}

// 获取用户评论被点赞的总数（用于"获赞"统计）
export async function handleGetReceivedLikeCount(request, env, db) {
    try {
        const authHeader = request.headers.get('Authorization');
        const token = authHeader?.replace('Bearer ', '');

        if (!token) {
            return jsonResponse({ error: '未登录' }, 401);
        }

        const decoded = await verifyToken(token, env);
        if (!decoded?.username) {
            return jsonResponse({ error: '无效的token' }, 401);
        }

        // 统计用户发表的评论被点赞的总数
        const result = await db.prepare(
            'SELECT COALESCE(SUM(like_count), 0) as totalLikes FROM comments WHERE username = ?'
        ).bind(decoded.username).first();

        return jsonResponse({
            success: true,
            receivedLikeCount: result?.totalLikes || 0
        });
    } catch (error) {
        console.error('Get received like count error:', error);
        return jsonResponse({ error: '获取失败' }, 500);
    }
}

