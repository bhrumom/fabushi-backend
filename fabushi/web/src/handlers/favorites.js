import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';

// 切换收藏状态
export async function handleToggleFavorite(request, env, db) {
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

        const { contentId, contentType, action, title, filePath, description } = await request.json();

        if (!contentId || !contentType) {
            return jsonResponse({ error: '缺少必要参数' }, 400);
        }

        if (action === 'favorite') {
            await db.prepare(
                `INSERT OR IGNORE INTO content_favorites 
                 (content_id, content_type, username, title, file_path, description, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(contentId, contentType, decoded.username, title || null, filePath || null, description || null, new Date().toISOString()).run();
        } else if (action === 'unfavorite') {
            await db.prepare(
                'DELETE FROM content_favorites WHERE content_id = ? AND username = ?'
            ).bind(contentId, decoded.username).run();
        }

        // 检查当前收藏状态
        const result = await db.prepare(
            'SELECT COUNT(*) as count FROM content_favorites WHERE content_id = ? AND username = ?'
        ).bind(contentId, decoded.username).first();

        return jsonResponse({
            success: true,
            isFavorited: result.count > 0
        });
    } catch (error) {
        console.error('Toggle favorite error:', error);
        return jsonResponse({ error: '操作失败' }, 500);
    }
}

// 获取用户收藏列表
export async function handleGetMyFavorites(request, env, db) {
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
            `SELECT content_id as id, content_type as contentType, title, file_path as filePath, 
                    description, created_at as favoritedAt 
             FROM content_favorites 
             WHERE username = ? 
             ORDER BY created_at DESC`
        ).bind(decoded.username).all();

        return jsonResponse({ success: true, favorites: results.results });
    } catch (error) {
        console.error('Get my favorites error:', error);
        return jsonResponse({ error: '获取失败' }, 500);
    }
}

// 批量检查收藏状态
export async function handleBatchCheckFavorites(request, env, db) {
    try {
        const authHeader = request.headers.get('Authorization');
        const token = authHeader?.replace('Bearer ', '');

        let username = null;
        if (token) {
            const decoded = await verifyToken(token, env);
            username = decoded?.username || null;
        }

        if (!username) {
            return jsonResponse({ favoriteStatus: {} });
        }

        const { contentIds } = await request.json();

        if (!contentIds || !Array.isArray(contentIds) || contentIds.length === 0) {
            return jsonResponse({ favoriteStatus: {} });
        }

        const placeholders = contentIds.map(() => '?').join(',');
        const results = await db.prepare(
            `SELECT content_id FROM content_favorites WHERE username = ? AND content_id IN (${placeholders})`
        ).bind(username, ...contentIds).all();

        const favoriteStatus = {};
        contentIds.forEach(id => {
            favoriteStatus[id] = results.results.some(r => r.content_id === id);
        });

        return jsonResponse({ favoriteStatus });
    } catch (error) {
        console.error('Batch check favorites error:', error);
        return jsonResponse({ error: '获取失败' }, 500);
    }
}
