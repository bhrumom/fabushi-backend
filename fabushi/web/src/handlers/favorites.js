import { jsonResponse } from '../utils/response.js';
import {
  backfillOwnerUserId,
  hasStableUserId,
  isMissingUserIdColumnError,
  optionalAuthIdentity,
  requireAuthIdentity,
  withOwnerScope,
} from '../utils/auth-identity.js';

async function backfillFavoritesUserId(db, auth) {
  await backfillOwnerUserId(db, auth, [{ table: 'content_favorites' }]);
}

async function insertFavorite(db, auth, {
  contentId,
  contentType,
  title,
  filePath,
  description,
}) {
  const now = new Date().toISOString();
  const insertLegacy = () => db.prepare(`
    INSERT OR IGNORE INTO content_favorites
      (content_id, content_type, username, title, file_path, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    contentId,
    contentType,
    auth.username,
    title || null,
    filePath || null,
    description || null,
    now
  ).run();

  if (!hasStableUserId(auth)) {
    return await insertLegacy();
  }

  try {
    return await db.prepare(`
      INSERT OR IGNORE INTO content_favorites
        (content_id, content_type, username, user_id, title, file_path, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      contentId,
      contentType,
      auth.username,
      auth.userId,
      title || null,
      filePath || null,
      description || null,
      now
    ).run();
  } catch (error) {
    if (!isMissingUserIdColumnError(error)) throw error;
    return await insertLegacy();
  }
}

async function deleteFavorite(db, auth, contentId) {
  return await withOwnerScope(db, auth, (scope) => ({
    sql: `
      DELETE FROM content_favorites
      WHERE content_id = ? AND ${scope.where}
    `,
    params: [contentId, ...scope.params],
  }), { mode: 'run' });
}

async function favoriteStatus(db, auth, contentId) {
  return await withOwnerScope(db, auth, (scope) => ({
    sql: `
      SELECT COUNT(*) as count
      FROM content_favorites
      WHERE content_id = ? AND ${scope.where}
    `,
    params: [contentId, ...scope.params],
  }), { mode: 'first' });
}

export async function handleToggleFavorite(request, env, db) {
  try {
    const auth = await requireAuthIdentity(request, env, db);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
    await backfillFavoritesUserId(db, auth);

    const { contentId, contentType, action, title, filePath, description } = await request.json();

    if (!contentId || !contentType) {
      return jsonResponse({ error: 'missing required params' }, 400);
    }

    if (action === 'favorite') {
      await insertFavorite(db, auth, { contentId, contentType, title, filePath, description });
    } else if (action === 'unfavorite') {
      await deleteFavorite(db, auth, contentId);
    }

    const result = await favoriteStatus(db, auth, contentId);
    return jsonResponse({
      success: true,
      isFavorited: (result?.count || 0) > 0,
    });
  } catch (error) {
    console.error('Toggle favorite error:', error);
    return jsonResponse({ error: 'operation failed' }, 500);
  }
}

export async function handleGetMyFavorites(request, env, db) {
  try {
    const auth = await requireAuthIdentity(request, env, db);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
    await backfillFavoritesUserId(db, auth);

    const results = await withOwnerScope(db, auth, (scope) => ({
      sql: `
        SELECT content_id as id, content_type as contentType, title,
               file_path as filePath, description, created_at as favoritedAt
        FROM content_favorites
        WHERE ${scope.where}
        ORDER BY created_at DESC
      `,
      params: [...scope.params],
    }));

    return jsonResponse({ success: true, favorites: results.results || [] });
  } catch (error) {
    console.error('Get my favorites error:', error);
    return jsonResponse({ error: 'get failed' }, 500);
  }
}

export async function handleBatchCheckFavorites(request, env, db) {
  try {
    const auth = await optionalAuthIdentity(request, env, db);
    if (!auth?.username) {
      return jsonResponse({ favoriteStatus: {} });
    }
    await backfillFavoritesUserId(db, auth);

    const { contentIds } = await request.json();
    if (!contentIds || !Array.isArray(contentIds) || contentIds.length === 0) {
      return jsonResponse({ favoriteStatus: {} });
    }

    const placeholders = contentIds.map(() => '?').join(',');
    const results = await withOwnerScope(db, auth, (scope) => ({
      sql: `
        SELECT content_id
        FROM content_favorites
        WHERE ${scope.where} AND content_id IN (${placeholders})
      `,
      params: [...scope.params, ...contentIds],
    }));

    const favoriteStatus = {};
    const favoriteIds = new Set((results.results || []).map((row) => row.content_id));
    contentIds.forEach((id) => {
      favoriteStatus[id] = favoriteIds.has(id);
    });

    return jsonResponse({ favoriteStatus });
  } catch (error) {
    console.error('Batch check favorites error:', error);
    return jsonResponse({ error: 'get failed' }, 500);
  }
}
