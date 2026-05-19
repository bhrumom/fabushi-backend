import { jsonResponse } from '../utils/response.js';
import {
  backfillOwnerUserId,
  hasStableUserId,
  isMissingUserIdColumnError,
  optionalAuthIdentity,
  requireAuthIdentity,
  withOwnerScope,
} from '../utils/auth-identity.js';

async function backfillLikesUserId(db, auth) {
  await backfillOwnerUserId(db, auth, [
    { table: 'content_likes', idColumn: 'account_user_id' },
    { table: 'comments', idColumn: 'account_user_id' },
  ]);
}

async function insertLike(db, auth, { contentId, contentType, title, filePath }) {
  const username = auth?.username || null;
  const now = new Date().toISOString();
  const insertLegacy = () => db.prepare(`
    INSERT OR IGNORE INTO content_likes
      (content_id, content_type, username, title, file_path, created_at, sync_version)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).bind(contentId, contentType, username, title || null, filePath || null, now).run();

  if (!hasStableUserId(auth)) {
    return await insertLegacy();
  }

  try {
    return await db.prepare(`
      INSERT OR IGNORE INTO content_likes
        (content_id, content_type, username, account_user_id, title, file_path, created_at, sync_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(contentId, contentType, username, auth.userId, title || null, filePath || null, now).run();
  } catch (error) {
    if (!isMissingUserIdColumnError(error)) throw error;
    return await insertLegacy();
  }
}

async function deleteLike(db, auth, contentId) {
  if (!auth?.username) {
    try {
      return await db.prepare(`
        DELETE FROM content_likes
        WHERE content_id = ? AND username IS NULL AND account_user_id IS NULL
      `).bind(contentId).run();
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) throw error;
      return await db.prepare('DELETE FROM content_likes WHERE content_id = ? AND username IS NULL')
        .bind(contentId)
        .run();
    }
  }

  return await withOwnerScope(db, auth, (scope) => ({
    sql: `
      DELETE FROM content_likes
      WHERE content_id = ? AND ${scope.where}
    `,
    params: [contentId, ...scope.params],
  }), { mode: 'run', idColumn: 'account_user_id' });
}

export async function handleToggleLike(request, env, db) {
  try {
    const auth = await optionalAuthIdentity(request, env, db);
    if (auth?.username) await backfillLikesUserId(db, auth);

    const { contentId, contentType, action, title, filePath } = await request.json();

    if (!contentId || !contentType) {
      return jsonResponse({ error: 'missing required params' }, 400);
    }

    if (action === 'like') {
      await insertLike(db, auth, { contentId, contentType, title, filePath });

      await db.prepare(`
        INSERT INTO content_metadata (content_id, content_type, title, file_path, like_count, comment_count)
        VALUES (?, ?, ?, ?, 1, 0)
        ON CONFLICT(content_id) DO UPDATE SET
          title = COALESCE(excluded.title, title),
          file_path = COALESCE(excluded.file_path, file_path),
          like_count = like_count + 1
      `).bind(contentId, contentType, title || null, filePath || null).run();
    } else if (action === 'unlike') {
      await deleteLike(db, auth, contentId);

      await db.prepare(`
        UPDATE content_metadata
        SET like_count = MAX(0, like_count - 1)
        WHERE content_id = ?
      `).bind(contentId).run();
    }

    const result = await db.prepare(
      'SELECT COUNT(*) as count FROM content_likes WHERE content_id = ?'
    ).bind(contentId).first();

    return jsonResponse({ success: true, likeCount: result?.count || 0 });
  } catch (error) {
    console.error('Toggle like error:', error);
    return jsonResponse({ error: 'operation failed' }, 500);
  }
}

export async function handleGetLikeCount(request, env, db) {
  try {
    const url = new URL(request.url);
    const contentId = url.searchParams.get('contentId');

    if (!contentId) {
      return jsonResponse({ error: 'missing contentId' }, 400);
    }

    const result = await db.prepare(
      'SELECT COUNT(*) as count FROM content_likes WHERE content_id = ?'
    ).bind(contentId).first();

    return jsonResponse({ likeCount: result?.count || 0 });
  } catch (error) {
    console.error('Get like count error:', error);
    return jsonResponse({ error: 'get failed' }, 500);
  }
}

export async function handleBatchGetLikeCounts(request, env, db) {
  try {
    const { contentIds } = await request.json();

    if (!contentIds || !Array.isArray(contentIds)) {
      return jsonResponse({ error: 'missing contentIds' }, 400);
    }

    const placeholders = contentIds.map(() => '?').join(',');
    const results = await db.prepare(`
      SELECT content_id, COUNT(*) as count
      FROM content_likes
      WHERE content_id IN (${placeholders})
      GROUP BY content_id
    `).bind(...contentIds).all();

    const likeCounts = {};
    (results.results || []).forEach((row) => {
      likeCounts[row.content_id] = row.count;
    });

    return jsonResponse({ likeCounts });
  } catch (error) {
    console.error('Batch get like counts error:', error);
    return jsonResponse({ error: 'get failed' }, 500);
  }
}

export async function handleGetMyLikes(request, env, db) {
  try {
    const auth = await requireAuthIdentity(request, env, db);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
    await backfillLikesUserId(db, auth);

    const results = await withOwnerScope(db, auth, (scope) => ({
      sql: `
        SELECT content_id as id, content_type as contentType, title,
               file_path as filePath, created_at as likedAt
        FROM content_likes
        WHERE ${scope.where}
        ORDER BY created_at DESC
      `,
      params: [...scope.params],
    }), { idColumn: 'account_user_id' });

    return jsonResponse({ success: true, likes: results.results || [] });
  } catch (error) {
    console.error('Get my likes error:', error);
    return jsonResponse({ error: 'get failed' }, 500);
  }
}

export async function handleGetReceivedLikeCount(request, env, db) {
  try {
    const auth = await requireAuthIdentity(request, env, db);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
    await backfillLikesUserId(db, auth);

    const result = await withOwnerScope(db, auth, (scope) => ({
      sql: `
        SELECT COALESCE(SUM(like_count), 0) as totalLikes
        FROM comments
        WHERE ${scope.where}
      `,
      params: [...scope.params],
    }), { mode: 'first', idColumn: 'account_user_id' });

    return jsonResponse({
      success: true,
      receivedLikeCount: result?.totalLikes || 0,
    });
  } catch (error) {
    console.error('Get received like count error:', error);
    return jsonResponse({ error: 'get failed' }, 500);
  }
}
