import { jsonResponse } from '../utils/response.js';

// 批量获取内容统计信息（点赞数 + 评论数）
export async function handleBatchGetContentStats(request, env, db) {
    try {
        const { contentIds } = await request.json();

        if (!contentIds || !Array.isArray(contentIds) || contentIds.length === 0) {
            return jsonResponse({ error: '内容ID列表不能为空' }, 400);
        }

        // 限制一次最多查询100个
        const limitedIds = contentIds.slice(0, 100);
        const placeholders = limitedIds.map(() => '?').join(',');

        // 并行查询点赞数和评论数
        const [likeResults, commentResults] = await Promise.all([
            // 查询点赞数
            db.db.prepare(`
                SELECT content_id, COUNT(*) as count
                FROM content_likes
                WHERE content_id IN (${placeholders})
                GROUP BY content_id
            `).bind(...limitedIds).all(),

            // 查询评论数
            db.db.prepare(`
                SELECT video_id, COUNT(*) as count
                FROM comments
                WHERE video_id IN (${placeholders})
                GROUP BY video_id
            `).bind(...limitedIds).all()
        ]);

        // 构建结果映射
        const stats = {};

        // 初始化所有ID
        for (const id of limitedIds) {
            stats[id] = { likeCount: 0, commentCount: 0 };
        }

        // 填充点赞数
        for (const row of likeResults.results) {
            if (stats[row.content_id]) {
                stats[row.content_id].likeCount = row.count;
            }
        }

        // 填充评论数
        for (const row of commentResults.results) {
            if (stats[row.video_id]) {
                stats[row.video_id].commentCount = row.count;
            }
        }

        return jsonResponse({ stats });
    } catch (error) {
        console.error('批量获取内容统计失败:', error);
        return jsonResponse({ error: '获取统计失败' }, 500);
    }
}
