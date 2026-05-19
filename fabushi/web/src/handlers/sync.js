import { jsonResponse } from '../utils/response.js';
import {
    hasStableUserId,
    isMissingUserIdColumnError,
    requireAuthIdentity,
    withOwnerScope,
} from '../utils/auth-identity.js';

const TABLE_SCOPES = {
    content_likes: { idColumn: 'account_user_id', usernameColumn: 'username' },
    comments: { idColumn: 'account_user_id', usernameColumn: 'username' },
    meditation_records: { idColumn: 'user_id', usernameColumn: 'username' },
    meditation_goals: { idColumn: 'user_id', usernameColumn: 'username' },
    user_follows: { idColumn: 'follower_user_id', usernameColumn: 'follower_username' },
};

function ensureSupportedTable(table) {
    if (!Object.hasOwn(TABLE_SCOPES, table)) {
        throw new Error(`unsupported sync table: ${table}`);
    }
    return TABLE_SCOPES[table];
}

async function requireAuth(request, env, db) {
    const auth = await requireAuthIdentity(request, env, db);
    if (auth.error) return auth;
    await backfillSyncUserId(db, auth);
    return auth;
}

async function backfillSyncUserId(db, auth) {
    if (!hasStableUserId(auth)) return;
    const updates = [
        `UPDATE content_likes SET account_user_id = ? WHERE account_user_id IS NULL AND username = ?`,
        `UPDATE comments SET account_user_id = ? WHERE account_user_id IS NULL AND username = ?`,
        `UPDATE meditation_records SET user_id = ? WHERE user_id IS NULL AND username = ?`,
        `UPDATE meditation_goals SET user_id = ? WHERE user_id IS NULL AND username = ?`,
        `UPDATE user_follows SET follower_user_id = ? WHERE follower_user_id IS NULL AND follower_username = ?`,
        `UPDATE user_sync_state SET user_id = ? WHERE user_id IS NULL AND username = ?`,
        `UPDATE sync_log SET user_id = ? WHERE user_id IS NULL AND username = ?`,
    ];

    await Promise.all(updates.map(async (sql) => {
        try {
            await db.prepare(sql).bind(auth.userId, auth.username).run();
        } catch (error) {
            if (!isMissingUserIdColumnError(error)) {
                console.warn('sync user_id backfill skipped:', error?.message || error);
            }
        }
    }));
}

async function allWithOwner(db, auth, table, build) {
    const scope = ensureSupportedTable(table);
    return await withOwnerScope(db, auth, build, scope);
}

async function firstWithOwner(db, auth, table, build) {
    const scope = ensureSupportedTable(table);
    return await withOwnerScope(db, auth, build, { ...scope, mode: 'first' });
}

async function runWithOwner(db, auth, table, build) {
    const scope = ensureSupportedTable(table);
    return await withOwnerScope(db, auth, build, { ...scope, mode: 'run' });
}

async function getMaxSyncVersion(db, auth) {
    if (hasStableUserId(auth)) {
        try {
            const row = await db.prepare(`
                SELECT MAX(sync_version) as max_version FROM (
                    SELECT MAX(sync_version) as sync_version FROM content_likes WHERE account_user_id = ? OR (account_user_id IS NULL AND username = ?)
                    UNION ALL
                    SELECT MAX(sync_version) as sync_version FROM comments WHERE account_user_id = ? OR (account_user_id IS NULL AND username = ?)
                    UNION ALL
                    SELECT MAX(sync_version) as sync_version FROM meditation_records WHERE user_id = ? OR (user_id IS NULL AND username = ?)
                    UNION ALL
                    SELECT MAX(sync_version) as sync_version FROM meditation_goals WHERE user_id = ? OR (user_id IS NULL AND username = ?)
                    UNION ALL
                    SELECT MAX(sync_version) as sync_version FROM user_follows WHERE follower_user_id = ? OR (follower_user_id IS NULL AND follower_username = ?)
                )
            `).bind(
                auth.userId, auth.username,
                auth.userId, auth.username,
                auth.userId, auth.username,
                auth.userId, auth.username,
                auth.userId, auth.username
            ).first();
            return row?.max_version || 0;
        } catch (error) {
            if (!isMissingUserIdColumnError(error)) throw error;
        }
    }

    const row = await db.prepare(`
        SELECT MAX(sync_version) as max_version FROM (
            SELECT MAX(sync_version) as sync_version FROM content_likes WHERE username = ?
            UNION ALL
            SELECT MAX(sync_version) as sync_version FROM comments WHERE username = ?
            UNION ALL
            SELECT MAX(sync_version) as sync_version FROM meditation_records WHERE username = ?
            UNION ALL
            SELECT MAX(sync_version) as sync_version FROM meditation_goals WHERE username = ?
            UNION ALL
            SELECT MAX(sync_version) as sync_version FROM user_follows WHERE follower_username = ?
        )
    `).bind(auth.username, auth.username, auth.username, auth.username, auth.username).first();
    return row?.max_version || 0;
}

export async function handleGetSyncData(request, env, db) {
    try {
        const auth = await requireAuth(request, env, db);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

        const url = new URL(request.url);
        const sinceVersion = parseInt(url.searchParams.get('since') || '0');

        const [likes, comments, meditationRecords, meditationGoals, follows] = await Promise.all([
            allWithOwner(db, auth, 'content_likes', (scope) => ({
                sql: `
                    SELECT id, content_id, content_type, title, file_path, created_at, sync_version
                    FROM content_likes
                    WHERE ${scope.where} AND sync_version > ?
                    ORDER BY sync_version ASC
                `,
                params: [...scope.params, sinceVersion],
            })),
            allWithOwner(db, auth, 'comments', (scope) => ({
                sql: `
                    SELECT id, content_id, content, parent_id, tag, content_title, like_count, created_at, sync_version
                    FROM comments
                    WHERE ${scope.where} AND sync_version > ?
                    ORDER BY sync_version ASC
                `,
                params: [...scope.params, sinceVersion],
            })),
            allWithOwner(db, auth, 'meditation_records', (scope) => ({
                sql: `
                    SELECT id, sutra_name, sutra_source, duration, chant_count, record_date,
                           local_time, timezone_offset_minutes, start_time, end_time,
                           is_manual, notes, created_at, sync_version
                    FROM meditation_records
                    WHERE ${scope.where} AND sync_version > ?
                    ORDER BY sync_version ASC
                `,
                params: [...scope.params, sinceVersion],
            })),
            allWithOwner(db, auth, 'meditation_goals', (scope) => ({
                sql: `
                    SELECT id, sutra_name, target_count, current_count, dedication, status,
                           created_at, updated_at, completed_at, sync_version
                    FROM meditation_goals
                    WHERE ${scope.where} AND sync_version > ?
                    ORDER BY sync_version ASC
                `,
                params: [...scope.params, sinceVersion],
            })),
            allWithOwner(db, auth, 'user_follows', (scope) => ({
                sql: `
                    SELECT id, following_username, created_at, sync_version
                    FROM user_follows
                    WHERE ${scope.where} AND sync_version > ?
                    ORDER BY sync_version ASC
                `,
                params: [...scope.params, sinceVersion],
            })),
        ]);

        const currentVersion = Math.max(await getMaxSyncVersion(db, auth), sinceVersion);

        return jsonResponse({
            success: true,
            syncVersion: currentVersion,
            data: {
                likes: likes.results || [],
                comments: comments.results || [],
                meditationRecords: meditationRecords.results || [],
                meditationGoals: meditationGoals.results || [],
                follows: follows.results || [],
            },
        });
    } catch (error) {
        console.error('get sync data failed:', error);
        return jsonResponse({ error: 'get sync data failed: ' + error.message }, 500);
    }
}

export async function handlePushSyncData(request, env, db) {
    try {
        const auth = await requireAuth(request, env, db);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

        const { changes } = await request.json();
        if (!changes || !Array.isArray(changes)) {
            return jsonResponse({ error: 'invalid sync data' }, 400);
        }

        const results = [];
        const conflicts = [];
        const now = new Date().toISOString();

        for (const change of changes) {
            const { table, action, data, clientVersion } = change;
            try {
                ensureSupportedTable(table);
                if (action === 'insert') {
                    const result = await handleInsert(db, auth, table, data, now);
                    results.push({ table, action, success: true, id: result.id });
                } else if (action === 'update') {
                    const result = await handleUpdate(db, auth, table, data, clientVersion);
                    if (result.conflict) {
                        conflicts.push({ table, recordId: data.id, serverVersion: result.serverVersion });
                    } else {
                        results.push({ table, action, success: true, id: data.id });
                    }
                } else if (action === 'delete') {
                    await handleDelete(db, auth, table, data.id);
                    results.push({ table, action, success: true, id: data.id });
                }
            } catch (error) {
                console.error(`sync change failed: ${table}/${action}`, error);
                results.push({ table, action, success: false, error: error.message });
            }
        }

        await updateSyncState(db, auth, now);

        return jsonResponse({
            success: true,
            results,
            conflicts,
            hasConflicts: conflicts.length > 0,
        });
    } catch (error) {
        console.error('push sync data failed:', error);
        return jsonResponse({ error: 'push sync data failed: ' + error.message }, 500);
    }
}

export async function handleGetSyncState(request, env, db) {
    try {
        const auth = await requireAuth(request, env, db);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

        const state = await getSyncState(db, auth);
        return jsonResponse({
            success: true,
            lastSyncVersion: state?.last_sync_version || 0,
            lastSyncAt: state?.last_sync_at || null,
        });
    } catch (error) {
        console.error('get sync state failed:', error);
        return jsonResponse({ error: 'get sync state failed' }, 500);
    }
}

async function getSyncState(db, auth) {
    if (hasStableUserId(auth)) {
        try {
            return await db.prepare(`
                SELECT last_sync_version, last_sync_at
                FROM user_sync_state
                WHERE user_id = ? OR (user_id IS NULL AND username = ?)
            `).bind(auth.userId, auth.username).first();
        } catch (error) {
            if (!isMissingUserIdColumnError(error)) throw error;
        }
    }

    return await db.prepare(`
        SELECT last_sync_version, last_sync_at
        FROM user_sync_state
        WHERE username = ?
    `).bind(auth.username).first();
}

async function updateSyncState(db, auth, now) {
    if (hasStableUserId(auth)) {
        try {
            await db.prepare(`
                INSERT INTO user_sync_state (username, user_id, last_sync_at)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    username = excluded.username,
                    last_sync_at = excluded.last_sync_at
            `).bind(auth.username, auth.userId, now).run();
            return;
        } catch (error) {
            const message = String(error?.message || error || '').toLowerCase();
            if (!isMissingUserIdColumnError(error) && !message.includes('on conflict clause does not match')) {
                throw error;
            }
        }
    }

    await db.prepare(`
        INSERT INTO user_sync_state (username, last_sync_at)
        VALUES (?, ?)
        ON CONFLICT(username) DO UPDATE SET last_sync_at = excluded.last_sync_at
    `).bind(auth.username, now).run();
}

async function nextVersionForTable(db, auth, table) {
    const row = await firstWithOwner(db, auth, table, (scope) => ({
        sql: `
            SELECT COALESCE(MAX(sync_version), 0) + 1 as next_version
            FROM ${table}
            WHERE ${scope.where}
        `,
        params: [...scope.params],
    }));
    return row?.next_version || 1;
}

async function insertWithStableFallback(db, auth, stableSql, stableParams, legacySql, legacyParams) {
    if (hasStableUserId(auth)) {
        try {
            return await db.prepare(stableSql).bind(...stableParams).run();
        } catch (error) {
            if (!isMissingUserIdColumnError(error)) throw error;
        }
    }
    return await db.prepare(legacySql).bind(...legacyParams).run();
}

async function resolveUserIdByUsername(db, username) {
    if (!username) return null;
    try {
        const row = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
        return row?.id ?? null;
    } catch (_) {
        return null;
    }
}

async function handleInsert(db, auth, table, data, now) {
    const nextVersion = await nextVersionForTable(db, auth, table);

    switch (table) {
        case 'content_likes':
            await insertWithStableFallback(
                db,
                auth,
                `INSERT INTO content_likes (content_id, content_type, username, account_user_id, title, file_path, created_at, sync_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [data.content_id, data.content_type || 'text', auth.username, auth.userId, data.title, data.file_path, now, nextVersion],
                `INSERT INTO content_likes (content_id, content_type, username, title, file_path, created_at, sync_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [data.content_id, data.content_type || 'text', auth.username, data.title, data.file_path, now, nextVersion]
            );
            break;

        case 'comments':
            await insertWithStableFallback(
                db,
                auth,
                `INSERT INTO comments (content_id, username, account_user_id, content, parent_id, tag, content_title, created_at, sync_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [data.content_id, auth.username, auth.userId, data.content, data.parent_id, data.tag, data.content_title, now, nextVersion],
                `INSERT INTO comments (content_id, username, content, parent_id, tag, content_title, created_at, sync_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [data.content_id, auth.username, data.content, data.parent_id, data.tag, data.content_title, now, nextVersion]
            );
            break;

        case 'meditation_records':
            await insertWithStableFallback(
                db,
                auth,
                `INSERT INTO meditation_records (
                    username, user_id, sutra_name, sutra_source, duration, chant_count, record_date,
                    local_time, timezone_offset_minutes, start_time, end_time,
                    is_manual, notes, created_at, sync_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    auth.username, auth.userId, data.sutra_name, data.sutra_source || 'custom',
                    data.duration || 0, data.chant_count || 0, data.record_date,
                    data.local_time || data.localTime || null,
                    data.timezone_offset_minutes || data.timezoneOffsetMinutes || null,
                    data.start_time || data.startTime || null,
                    data.end_time || data.endTime || null,
                    data.is_manual || 0, data.notes, now, nextVersion,
                ],
                `INSERT INTO meditation_records (
                    username, sutra_name, sutra_source, duration, chant_count, record_date,
                    local_time, timezone_offset_minutes, start_time, end_time,
                    is_manual, notes, created_at, sync_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    auth.username, data.sutra_name, data.sutra_source || 'custom',
                    data.duration || 0, data.chant_count || 0, data.record_date,
                    data.local_time || data.localTime || null,
                    data.timezone_offset_minutes || data.timezoneOffsetMinutes || null,
                    data.start_time || data.startTime || null,
                    data.end_time || data.endTime || null,
                    data.is_manual || 0, data.notes, now, nextVersion,
                ]
            );
            break;

        case 'meditation_goals':
            await insertWithStableFallback(
                db,
                auth,
                `INSERT INTO meditation_goals (username, user_id, sutra_name, target_count, current_count, dedication, status, created_at, sync_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [auth.username, auth.userId, data.sutra_name, data.target_count, data.current_count || 0, data.dedication, data.status || 'active', now, nextVersion],
                `INSERT INTO meditation_goals (username, sutra_name, target_count, current_count, dedication, status, created_at, sync_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [auth.username, data.sutra_name, data.target_count, data.current_count || 0, data.dedication, data.status || 'active', now, nextVersion]
            );
            break;

        case 'user_follows': {
            const followingUserId = await resolveUserIdByUsername(db, data.following_username);
            if (hasStableUserId(auth) && followingUserId !== null && followingUserId !== undefined) {
                try {
                    await db.prepare(`
                        INSERT INTO user_follows (follower_username, following_username, follower_user_id, following_user_id, created_at, sync_version)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `).bind(auth.username, data.following_username, auth.userId, followingUserId, now, nextVersion).run();
                    break;
                } catch (error) {
                    if (!isMissingUserIdColumnError(error)) throw error;
                }
            }
            await db.prepare(`
                INSERT INTO user_follows (follower_username, following_username, created_at, sync_version)
                VALUES (?, ?, ?, ?)
            `).bind(auth.username, data.following_username, now, nextVersion).run();
            break;
        }
    }

    return { id: data.id, version: nextVersion };
}

async function handleUpdate(db, auth, table, data, clientVersion) {
    const serverRecord = await firstWithOwner(db, auth, table, (scope) => ({
        sql: `
            SELECT sync_version
            FROM ${table}
            WHERE id = ? AND ${scope.where}
        `,
        params: [data.id, ...scope.params],
    }));

    if (!serverRecord) {
        throw new Error('record not found');
    }

    if (serverRecord.sync_version > clientVersion) {
        return { conflict: true, serverVersion: serverRecord.sync_version };
    }

    const nextVersion = serverRecord.sync_version + 1;
    const now = new Date().toISOString();

    switch (table) {
        case 'meditation_goals':
            await runWithOwner(db, auth, table, (scope) => ({
                sql: `
                    UPDATE meditation_goals
                    SET current_count = ?, status = ?, updated_at = ?, sync_version = ?
                    WHERE id = ? AND ${scope.where}
                `,
                params: [data.current_count, data.status, now, nextVersion, data.id, ...scope.params],
            }));
            break;

        case 'meditation_records':
            await runWithOwner(db, auth, table, (scope) => ({
                sql: `
                    UPDATE meditation_records
                    SET duration = ?, chant_count = ?, local_time = ?, timezone_offset_minutes = ?, notes = ?, sync_version = ?
                    WHERE id = ? AND ${scope.where}
                `,
                params: [
                    data.duration,
                    data.chant_count,
                    data.local_time || data.localTime || null,
                    data.timezone_offset_minutes || data.timezoneOffsetMinutes || null,
                    data.notes,
                    nextVersion,
                    data.id,
                    ...scope.params,
                ],
            }));
            break;
    }

    return { conflict: false, version: nextVersion };
}

async function handleDelete(db, auth, table, recordId) {
    await runWithOwner(db, auth, table, (scope) => ({
        sql: `
            DELETE FROM ${table}
            WHERE id = ? AND ${scope.where}
        `,
        params: [recordId, ...scope.params],
    }));
}
