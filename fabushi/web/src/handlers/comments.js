import { jsonResponse } from '../utils/response.js';
import {
    backfillOwnerUserId,
    hasStableUserId,
    isMissingUserIdColumnError,
    requireAuthIdentity,
} from '../utils/auth-identity.js';

async function backfillCommentsUserId(db, auth) {
    await backfillOwnerUserId(db, auth, [
        { table: 'comments', idColumn: 'account_user_id' },
    ]);
}

function isCommentShapeFallbackError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return isMissingUserIdColumnError(error) ||
        message.includes('not null constraint failed: comments.video_id');
}

async function insertComment(db, auth, {
    contentId,
    content,
    parentId,
    tag,
    videoTitle,
    mainPractice,
    now,
}) {
    if (hasStableUserId(auth)) {
        try {
            return await db.db.prepare(`
      INSERT INTO comments (content_id, username, account_user_id, content, created_at, parent_id, tag, content_title, main_practice, sync_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(contentId, auth.username, auth.userId, content, now, parentId || null, tag || null, videoTitle || null, mainPractice || null).run();
        } catch (error) {
            if (!isCommentShapeFallbackError(error)) throw error;
        }
    }

    try {
        return await db.db.prepare(`
      INSERT INTO comments (content_id, username, content, created_at, parent_id, tag, content_title, main_practice, sync_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(contentId, auth.username, content, now, parentId || null, tag || null, videoTitle || null, mainPractice || null).run();
    } catch (error) {
        if (!isCommentShapeFallbackError(error)) throw error;
    }

    return await db.db.prepare(`
      INSERT INTO comments (content_id, video_id, username, user_id, content, created_at, parent_id, tag, content_title, main_practice, sync_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(contentId, contentId, auth.username, auth.username, content, now, parentId || null, tag || null, videoTitle || null, mainPractice || null).run();
}

// Get comments.
export async function handleGetComments(request, env, db) {
    try {
        const url = new URL(request.url);
        // Support both contentId and the legacy videoId field.
        const contentId = url.searchParams.get('contentId') || url.searchParams.get('videoId');
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
        const offset = (page - 1) * pageSize;

        if (!contentId) {
            return jsonResponse({ error: 'content id required' }, 400);
        }

        // Comments are keyed by content_id while we keep user profile data joined
        // through username for compatibility with existing rows.
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
        console.error('failed to fetch comments:', error);
        return jsonResponse({ error: 'failed to fetch comments' }, 500);
    }
}

// Create a comment.
export async function handlePostComment(request, env, db) {
    try {
        const auth = await requireAuthIdentity(request, env, db.db || db);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
        await backfillCommentsUserId(db.db || db, auth);

        // Support contentId and the legacy videoId payload field.
        const { videoId, contentId: requestContentId, content, parentId, tag, videoTitle, filePath, mainPractice } = await request.json();
        const contentId = requestContentId || filePath || videoId;

        if (!contentId || !content) {
            return jsonResponse({ error: 'content id and comment content required' }, 400);
        }

        const validTags = ['ganying', 'fayuan', 'practice', null];
        if (tag && !validTags.includes(tag)) {
            return jsonResponse({ error: 'invalid comment tag' }, 400);
        }

        const now = new Date().toISOString();

        // Write the most modern comment shape first, then fall back for older
        // deployed schemas that have not received the new columns yet.
        const result = await insertComment(db, auth, {
            contentId,
            content,
            parentId,
            tag,
            videoTitle,
            mainPractice,
            now,
        });

        await db.db.prepare(`
            INSERT INTO content_metadata (content_id, content_type, title, file_path, like_count, comment_count)
            VALUES (?, 'text', ?, ?, 0, 1)
            ON CONFLICT(content_id) DO UPDATE SET
              title = COALESCE(excluded.title, title),
              file_path = COALESCE(excluded.file_path, file_path),
              comment_count = comment_count + 1
        `).bind(contentId, videoTitle || null, filePath || null).run();

        const newComment = await db.db.prepare(`
      SELECT
        c.id, c.content_id, c.username as user_id, c.content, c.created_at, c.parent_id, c.like_count, c.tag, c.content_title, c.main_practice,
        u.username, u.nickname, u.avatar
      FROM comments c
      LEFT JOIN users u ON c.username = u.username
      WHERE c.id = ?
    `).bind(result.meta.last_row_id).first();

        return jsonResponse({
            message: 'comment created',
            comment: newComment
        }, 201);
    } catch (error) {
        console.error('failed to create comment:', error);
        return jsonResponse({ error: 'failed to create comment: ' + error.message }, 500);
    }
}

// Delete a comment.
export async function handleDeleteComment(request, env, db) {
    try {
        const auth = await requireAuthIdentity(request, env, db.db || db);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
        await backfillCommentsUserId(db.db || db, auth);

        const url = new URL(request.url);
        const commentId = url.searchParams.get('id');

        if (!commentId) {
            return jsonResponse({ error: 'comment id required' }, 400);
        }

        let comment;
        try {
            comment = await db.db.prepare(`
      SELECT username, account_user_id
      FROM comments
      WHERE id = ?
    `).bind(commentId).first();
        } catch (error) {
            if (!isMissingUserIdColumnError(error)) throw error;
            comment = await db.db.prepare(`
      SELECT username
      FROM comments
      WHERE id = ?
    `).bind(commentId).first();
        }

        if (!comment) {
            return jsonResponse({ error: 'comment not found' }, 404);
        }

        const commentUserId = Number(comment.account_user_id);
        const isOwnerById = Number.isFinite(commentUserId) && commentUserId === auth.userId;
        const isOwnerByUsername = comment.username === auth.username;
        if (!isOwnerById && !isOwnerByUsername) {
            return jsonResponse({ error: 'forbidden' }, 403);
        }

        await db.db.prepare(`
      DELETE FROM comments WHERE id = ?
    `).bind(commentId).run();

        return jsonResponse({ message: 'comment deleted' });
    } catch (error) {
        console.error('delete comment failed:', error);
        return jsonResponse({ error: 'delete comment failed' }, 500);
    }
}

// Get tagged community posts such as ganying/fayuan.
export async function handleGetTaggedPosts(request, env, db) {
    try {
        const url = new URL(request.url);
        const tag = url.searchParams.get('tag');
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
        const offset = (page - 1) * pageSize;

        if (!tag || !['ganying', 'fayuan'].includes(tag)) {
            return jsonResponse({ error: 'tag must be ganying or fayuan' }, 400);
        }

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

        const postsWithTitle = posts.results.map(post => {
            if (post.content_title && post.content_title.trim()) {
                return post;
            }

            let contentTitle = '';
            if (post.content_id) {
                const parts = post.content_id.split('/');
                const filename = parts[parts.length - 1];
                contentTitle = filename.replace(/\.[^/.]+$/, '');
                contentTitle = contentTitle.replace(/[_-]/g, ' ');
            }
            return { ...post, content_title: contentTitle };
        });

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
        console.error('failed to fetch tagged posts:', error);
        return jsonResponse({ error: 'failed to fetch tagged posts' }, 500);
    }
}

// Get the hot feed from comment and metadata aggregates.
export async function handleGetHotFeed(request, env, db) {
    try {
        const url = new URL(request.url);
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
        const offset = (page - 1) * pageSize;

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
        console.error('failed to fetch hot feed:', error);
        return jsonResponse({ error: 'failed to fetch hot feed' }, 500);
    }
}

// Get a single tagged post by id.
export async function handleGetPostDetail(request, env, db) {
    try {
        const url = new URL(request.url);
        const postId = url.searchParams.get('id');

        if (!postId) {
            return jsonResponse({ error: 'post id required' }, 400);
        }

        const post = await db.db.prepare(`
      SELECT
        c.id, c.content_id, c.username as user_id, c.content, c.created_at, c.tag, c.like_count,
        u.username, u.nickname, u.avatar
      FROM comments c
      LEFT JOIN users u ON c.username = u.username
      WHERE c.id = ? AND c.tag IS NOT NULL AND c.tag != 'practice'
    `).bind(postId).first();

        if (!post) {
            return jsonResponse({ error: 'post not found' }, 404);
        }

        return jsonResponse({ post });
    } catch (error) {
        console.error('failed to fetch post detail:', error);
        return jsonResponse({ error: 'failed to fetch post detail' }, 500);
    }
}

// Batch-fetch comment counts for a list of content ids.
export async function handleBatchGetCommentCounts(request, env, db) {
    try {
        const { videoIds } = await request.json();

        if (!videoIds || !Array.isArray(videoIds) || videoIds.length === 0) {
            return jsonResponse({ error: 'videoIds must be a non-empty array' }, 400);
        }

        const limitedIds = videoIds.slice(0, 100);

        const placeholders = limitedIds.map(() => '?').join(',');
        const results = await db.db.prepare(`
            SELECT content_id, COUNT(*) as comment_count
            FROM comments
            WHERE content_id IN (${placeholders}) AND (tag IS NULL OR tag != 'practice')
            GROUP BY content_id
        `).bind(...limitedIds).all();

        const counts = {};
        for (const row of results.results) {
            counts[row.content_id] = row.comment_count;
        }

        for (const id of limitedIds) {
            if (!(id in counts)) {
                counts[id] = 0;
            }
        }

        return jsonResponse({ counts });
    } catch (error) {
        console.error('failed to batch fetch comment counts:', error);
        return jsonResponse({ error: 'failed to fetch comment counts' }, 500);
    }
}
