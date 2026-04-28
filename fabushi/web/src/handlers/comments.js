import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';

// 获取评论列表
export async function handleGetComments(request, env, db) {
    try {
        const url = new URL(request.url);
        // 支持 contentId 和 videoId（向后兼容）
        const contentId = url.searchParams.get('contentId') || url.searchParams.get('videoId');
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
        const offset = (page - 1) * pageSize;

        if (!contentId) {
            return jsonResponse({ error: '内容ID不能为空' }, 400);
        }

        // 获取评论列表，包含用户信息
        // 使用content_id统一标识（替代原来的video_id）
        const comments = await db.db.prepare(`
      SELECT 
        c.id, c.content_id, c.username as user_id, c.content, c.created_at, c.parent_id, c.like_count, c.tag, c.main_practice,
        u.username, u.nickname, u.avatar
      FROM comments c
      LEFT JOIN users u ON c.username = u.username
      WHERE c.content_id = ? AND (c.tag IS NULL OR c.tag != 'practice')
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(contentId, pageSize, offset).all();

        // 获取总评论数
        const totalResult = await db.db.prepare(`
      SELECT COUNT(*) as count FROM comments WHERE content_id = ? AND (tag IS NULL OR tag != 'practice')
    `).bind(contentId).first();

        return jsonResponse({
            comments: comments.results,
            total: totalResult.count,
            page,
            pageSize
        });
    } catch (error) {
        console.error('获取评论失败:', error);
        return jsonResponse({ error: '获取评论失败' }, 500);
    }
}

// 发布评论
export async function handlePostComment(request, env, db) {
    try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return jsonResponse({ error: '未提供认证信息' }, 401);
        }

        const token = authHeader.substring(7);
        const tokenData = await verifyToken(token, env);
        if (!tokenData) {
            return jsonResponse({ error: '认证失败' }, 401);
        }

        // 支持 contentId 和 videoId（向后兼容）
        const { videoId, contentId: requestContentId, content, parentId, tag, videoTitle, filePath, mainPractice } = await request.json();
        const contentId = requestContentId || filePath || videoId;

        if (!contentId || !content) {
            return jsonResponse({ error: '内容ID和评论内容不能为空' }, 400);
        }

        // 验证标签值
        const validTags = ['ganying', 'fayuan', 'practice', null];
        if (tag && !validTags.includes(tag)) {
            return jsonResponse({ error: '无效的标签类型' }, 400);
        }

        const now = new Date().toISOString();

        // 插入评论（使用统一的 content_id，同时填充 video_id 和 user_id 保持向后兼容）
        const result = await db.db.prepare(`
      INSERT INTO comments (content_id, video_id, username, user_id, content, created_at, parent_id, tag, content_title, main_practice, sync_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(contentId, contentId, tokenData.username, tokenData.username, content, now, parentId || null, tag || null, videoTitle || null, mainPractice || null).run();

        // 同步更新 content_metadata 的 comment_count
        await db.db.prepare(`
            INSERT INTO content_metadata (content_id, content_type, title, file_path, like_count, comment_count)
            VALUES (?, 'text', ?, ?, 0, 1)
            ON CONFLICT(content_id) DO UPDATE SET 
              title = COALESCE(excluded.title, title),
              file_path = COALESCE(excluded.file_path, file_path),
              comment_count = comment_count + 1
        `).bind(contentId, videoTitle || null, filePath || null).run();

        // 获取新插入的评论详情（包含用户信息、标签、内容标题、主修功课）
        const newComment = await db.db.prepare(`
      SELECT 
        c.id, c.content_id, c.username as user_id, c.content, c.created_at, c.parent_id, c.like_count, c.tag, c.content_title, c.main_practice,
        u.username, u.nickname, u.avatar
      FROM comments c
      LEFT JOIN users u ON c.username = u.username
      WHERE c.id = ?
    `).bind(result.meta.last_row_id).first();

        return jsonResponse({
            message: '评论发布成功',
            comment: newComment
        }, 201);
    } catch (error) {
        console.error('发布评论失败:', error);
        return jsonResponse({ error: '发布评论失败: ' + error.message }, 500);
    }
}

// 删除评论
export async function handleDeleteComment(request, env, db) {
    try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return jsonResponse({ error: '未提供认证信息' }, 401);
        }

        const token = authHeader.substring(7);
        const tokenData = await verifyToken(token, env);
        if (!tokenData) {
            return jsonResponse({ error: '认证失败' }, 401);
        }

        const url = new URL(request.url);
        const commentId = url.searchParams.get('id');

        if (!commentId) {
            return jsonResponse({ error: '评论ID不能为空' }, 400);
        }

        // 检查评论是否存在以及是否属于当前用户
        const comment = await db.db.prepare(`
      SELECT username FROM comments WHERE id = ?
    `).bind(commentId).first();

        if (!comment) {
            return jsonResponse({ error: '评论不存在' }, 404);
        }

        // 只有作者可以删除评论 (后续可添加管理员权限)
        if (comment.username !== tokenData.username) {
            return jsonResponse({ error: '无权删除此评论' }, 403);
        }

        await db.db.prepare(`
      DELETE FROM comments WHERE id = ?
    `).bind(commentId).run();

        return jsonResponse({ message: '评论已删除' });
    } catch (error) {
        console.error('删除评论失败:', error);
        return jsonResponse({ error: '删除评论失败' }, 500);
    }
}

// 获取带标签的帖子列表（感应/发愿）
export async function handleGetTaggedPosts(request, env, db) {
    try {
        const url = new URL(request.url);
        const tag = url.searchParams.get('tag');
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
        const offset = (page - 1) * pageSize;

        if (!tag || !['ganying', 'fayuan'].includes(tag)) {
            return jsonResponse({ error: '标签类型无效，必须是 ganying 或 fayuan' }, 400);
        }

        // 获取带标签的帖子，包含用户信息、点赞数和内容标题
        const posts = await db.db.prepare(`
      SELECT 
        c.id, c.content_id, c.username as user_id, c.content, c.created_at, c.tag, c.like_count, c.content_title,
        u.username, u.nickname, u.avatar
      FROM comments c
      LEFT JOIN users u ON c.username = u.username
      WHERE c.tag = ?
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(tag, pageSize, offset).all();

        // 为每个帖子处理 content_title（优先使用数据库存储的标题，否则从 content_id 提取）
        const postsWithTitle = posts.results.map(post => {
            // 如果数据库有存储的标题，直接使用
            if (post.content_title && post.content_title.trim()) {
                return post;
            }

            // 否则尝试从 content_id 提取（兼容旧数据）
            let contentTitle = '';
            if (post.content_id) {
                const parts = post.content_id.split('/');
                const filename = parts[parts.length - 1];
                contentTitle = filename.replace(/\.[^/.]+$/, '');
                contentTitle = contentTitle.replace(/[_-]/g, ' ');
            }
            return { ...post, content_title: contentTitle };
        });

        // 获取总数
        const totalResult = await db.db.prepare(`
      SELECT COUNT(*) as count FROM comments WHERE tag = ?
    `).bind(tag).first();

        return jsonResponse({
            posts: postsWithTitle,
            total: totalResult.count,
            page,
            pageSize
        });
    } catch (error) {
        console.error('获取帖子列表失败:', error);
        return jsonResponse({ error: '获取帖子列表失败' }, 500);
    }
}

// 获取热门内容（从统一的 content_metadata 表获取，包含点赞数和评论数）
export async function handleGetHotFeed(request, env, db) {
    try {
        const url = new URL(request.url);
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
        const offset = (page - 1) * pageSize;

        // 从统一的 content_metadata 表获取热门内容
        const hotContent = await db.db.prepare(`
          SELECT 
            content_id as id,
            content_type,
            title,
            file_path,
            like_count,
            comment_count
          FROM content_metadata
          WHERE like_count > 0 OR comment_count > 0
          ORDER BY like_count DESC, comment_count DESC
          LIMIT ? OFFSET ?
        `).bind(pageSize, offset).all();

        // 获取总数
        const totalResult = await db.db.prepare(`
          SELECT COUNT(*) as count FROM content_metadata WHERE like_count > 0 OR comment_count > 0
        `).first();

        return jsonResponse({
            hotContent: hotContent.results,
            total: totalResult.count,
            page,
            pageSize
        });
    } catch (error) {
        console.error('获取热门内容失败:', error);
        return jsonResponse({ error: '获取热门内容失败' }, 500);
    }
}

// 获取帖子详情（包含原视频信息）
export async function handleGetPostDetail(request, env, db) {
    try {
        const url = new URL(request.url);
        const postId = url.searchParams.get('id');

        if (!postId) {
            return jsonResponse({ error: '帖子ID不能为空' }, 400);
        }

        // 获取帖子详情
        const post = await db.db.prepare(`
      SELECT 
        c.id, c.content_id, c.username as user_id, c.content, c.created_at, c.tag, c.like_count,
        u.username, u.nickname, u.avatar
      FROM comments c
      LEFT JOIN users u ON c.username = u.username
      WHERE c.id = ? AND c.tag IS NOT NULL AND c.tag != 'practice'
    `).bind(postId).first();

        if (!post) {
            return jsonResponse({ error: '帖子不存在' }, 404);
        }

        return jsonResponse({ post });
    } catch (error) {
        console.error('获取帖子详情失败:', error);
        return jsonResponse({ error: '获取帖子详情失败' }, 500);
    }
}

// 批量获取评论数
export async function handleBatchGetCommentCounts(request, env, db) {
    try {
        const { videoIds } = await request.json();

        if (!videoIds || !Array.isArray(videoIds) || videoIds.length === 0) {
            return jsonResponse({ error: '视频ID列表不能为空' }, 400);
        }

        // 限制一次最多查询100个
        const limitedIds = videoIds.slice(0, 100);

        // 构建查询 - 使用 content_id 统一标识
        const placeholders = limitedIds.map(() => '?').join(',');
        const results = await db.db.prepare(`
            SELECT content_id, COUNT(*) as comment_count
            FROM comments
            WHERE content_id IN (${placeholders}) AND (tag IS NULL OR tag != 'practice')
            GROUP BY content_id
        `).bind(...limitedIds).all();

        // 构建映射
        const counts = {};
        for (const row of results.results) {
            counts[row.content_id] = row.comment_count;
        }

        // 确保所有请求的ID都有值（没有评论的返回0）
        for (const id of limitedIds) {
            if (!(id in counts)) {
                counts[id] = 0;
            }
        }

        return jsonResponse({ counts });
    } catch (error) {
        console.error('批量获取评论数失败:', error);
        return jsonResponse({ error: '获取评论数失败' }, 500);
    }
}
