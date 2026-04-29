import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';

/**
 * 同步服务 - 处理客户端数据同步
 * 
 * 设计原则:
 * 1. 云端为单一数据源
 * 2. 使用 sync_version 进行增量同步
 * 3. 支持冲突检测（乐观锁）
 */

// 获取用户所有需要同步的数据（增量同步）
export async function handleGetSyncData(request, env, db) {
    try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return jsonResponse({ error: '未提供认证信息' }, 401);
        }

        const token = authHeader.substring(7);
        const tokenData = await verifyToken(token, env);
        if (!tokenData?.username) {
            return jsonResponse({ error: '认证失败' }, 401);
        }

        const url = new URL(request.url);
        const sinceVersion = parseInt(url.searchParams.get('since') || '0');
        const username = tokenData.username;

        // 并行获取所有需要同步的数据
        const [likes, comments, meditationRecords, meditationGoals, follows] = await Promise.all([
            // 点赞数据
            db.prepare(`
                SELECT id, content_id, content_type, title, file_path, created_at, sync_version
                FROM content_likes 
                WHERE username = ? AND sync_version > ?
                ORDER BY sync_version ASC
            `).bind(username, sinceVersion).all(),

            // 评论数据
            db.prepare(`
                SELECT id, content_id, content, parent_id, tag, content_title, like_count, created_at, sync_version
                FROM comments 
                WHERE username = ? AND sync_version > ?
                ORDER BY sync_version ASC
            `).bind(username, sinceVersion).all(),

            // 修行记录
            db.prepare(`
                SELECT id, sutra_name, sutra_source, duration, chant_count, record_date,
                       local_time, timezone_offset_minutes, start_time, end_time,
                       is_manual, notes, created_at, sync_version
                FROM meditation_records 
                WHERE username = ? AND sync_version > ?
                ORDER BY sync_version ASC
            `).bind(username, sinceVersion).all(),

            // 修行目标
            db.prepare(`
                SELECT id, sutra_name, target_count, current_count, dedication, status, created_at, updated_at, completed_at, sync_version
                FROM meditation_goals 
                WHERE username = ? AND sync_version > ?
                ORDER BY sync_version ASC
            `).bind(username, sinceVersion).all(),

            // 关注关系
            db.prepare(`
                SELECT id, following_username, created_at, sync_version
                FROM user_follows 
                WHERE follower_username = ? AND sync_version > ?
                ORDER BY sync_version ASC
            `).bind(username, sinceVersion).all()
        ]);

        // 获取当前最大同步版本
        const maxVersionResult = await db.prepare(`
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
        `).bind(username, username, username, username, username).first();

        const currentVersion = maxVersionResult?.max_version || sinceVersion;

        return jsonResponse({
            success: true,
            syncVersion: currentVersion,
            data: {
                likes: likes.results || [],
                comments: comments.results || [],
                meditationRecords: meditationRecords.results || [],
                meditationGoals: meditationGoals.results || [],
                follows: follows.results || []
            }
        });
    } catch (error) {
        console.error('获取同步数据失败:', error);
        return jsonResponse({ error: '获取同步数据失败: ' + error.message }, 500);
    }
}

// 推送客户端变更到云端
export async function handlePushSyncData(request, env, db) {
    try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return jsonResponse({ error: '未提供认证信息' }, 401);
        }

        const token = authHeader.substring(7);
        const tokenData = await verifyToken(token, env);
        if (!tokenData?.username) {
            return jsonResponse({ error: '认证失败' }, 401);
        }

        const username = tokenData.username;
        const { changes } = await request.json();

        if (!changes || !Array.isArray(changes)) {
            return jsonResponse({ error: '无效的同步数据' }, 400);
        }

        const results = [];
        const conflicts = [];
        const now = new Date().toISOString();

        for (const change of changes) {
            const { table, action, data, clientVersion } = change;

            try {
                if (action === 'insert') {
                    const result = await handleInsert(db, username, table, data, now);
                    results.push({ table, action, success: true, id: result.id });
                } else if (action === 'update') {
                    const result = await handleUpdate(db, username, table, data, clientVersion);
                    if (result.conflict) {
                        conflicts.push({ table, recordId: data.id, serverVersion: result.serverVersion });
                    } else {
                        results.push({ table, action, success: true, id: data.id });
                    }
                } else if (action === 'delete') {
                    await handleDelete(db, username, table, data.id);
                    results.push({ table, action, success: true, id: data.id });
                }
            } catch (error) {
                console.error(`处理变更失败: ${table}/${action}`, error);
                results.push({ table, action, success: false, error: error.message });
            }
        }

        // 更新用户同步状态
        await db.prepare(`
            INSERT INTO user_sync_state (username, last_sync_at)
            VALUES (?, ?)
            ON CONFLICT(username) DO UPDATE SET last_sync_at = excluded.last_sync_at
        `).bind(username, now).run();

        return jsonResponse({
            success: true,
            results,
            conflicts,
            hasConflicts: conflicts.length > 0
        });
    } catch (error) {
        console.error('推送同步数据失败:', error);
        return jsonResponse({ error: '推送同步数据失败: ' + error.message }, 500);
    }
}

// 获取用户同步状态
export async function handleGetSyncState(request, env, db) {
    try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return jsonResponse({ error: '未提供认证信息' }, 401);
        }

        const token = authHeader.substring(7);
        const tokenData = await verifyToken(token, env);
        if (!tokenData?.username) {
            return jsonResponse({ error: '认证失败' }, 401);
        }

        const state = await db.prepare(`
            SELECT last_sync_version, last_sync_at FROM user_sync_state WHERE username = ?
        `).bind(tokenData.username).first();

        return jsonResponse({
            success: true,
            lastSyncVersion: state?.last_sync_version || 0,
            lastSyncAt: state?.last_sync_at || null
        });
    } catch (error) {
        console.error('获取同步状态失败:', error);
        return jsonResponse({ error: '获取同步状态失败' }, 500);
    }
}

// 内部函数：处理插入
async function handleInsert(db, username, table, data, now) {
    // 获取下一个同步版本号
    const versionResult = await db.prepare(`
        SELECT COALESCE(MAX(sync_version), 0) + 1 as next_version FROM ${table} WHERE username = ?
    `).bind(username).first();
    const nextVersion = versionResult.next_version;

    switch (table) {
        case 'content_likes':
            await db.prepare(`
                INSERT INTO content_likes (content_id, content_type, username, title, file_path, created_at, sync_version)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).bind(data.content_id, data.content_type || 'text', username, data.title, data.file_path, now, nextVersion).run();
            break;

        case 'comments':
            await db.prepare(`
                INSERT INTO comments (content_id, username, content, parent_id, tag, content_title, created_at, sync_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(data.content_id, username, data.content, data.parent_id, data.tag, data.content_title, now, nextVersion).run();
            break;

        case 'meditation_records':
            await db.prepare(`
                INSERT INTO meditation_records (
                    username, sutra_name, sutra_source, duration, chant_count, record_date,
                    local_time, timezone_offset_minutes, start_time, end_time,
                    is_manual, notes, created_at, sync_version
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
                username,
                data.sutra_name,
                data.sutra_source || 'custom',
                data.duration || 0,
                data.chant_count || 0,
                data.record_date,
                data.local_time || data.localTime || null,
                data.timezone_offset_minutes || data.timezoneOffsetMinutes || null,
                data.start_time || data.startTime || null,
                data.end_time || data.endTime || null,
                data.is_manual || 0,
                data.notes,
                now,
                nextVersion
            ).run();
            break;

        case 'meditation_goals':
            await db.prepare(`
                INSERT INTO meditation_goals (username, sutra_name, target_count, current_count, dedication, status, created_at, sync_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(username, data.sutra_name, data.target_count, data.current_count || 0, data.dedication, data.status || 'active', now, nextVersion).run();
            break;

        case 'user_follows':
            await db.prepare(`
                INSERT INTO user_follows (follower_username, following_username, created_at, sync_version)
                VALUES (?, ?, ?, ?)
            `).bind(username, data.following_username, now, nextVersion).run();
            break;
    }

    return { id: data.id, version: nextVersion };
}

// 内部函数：处理更新（带冲突检测）
async function handleUpdate(db, username, table, data, clientVersion) {
    // 检查服务器版本
    const serverRecord = await db.prepare(`
        SELECT sync_version FROM ${table} WHERE id = ? AND username = ?
    `).bind(data.id, username).first();

    if (!serverRecord) {
        throw new Error('记录不存在');
    }

    // 冲突检测：如果服务器版本高于客户端版本，说明有其他客户端已经修改过
    if (serverRecord.sync_version > clientVersion) {
        return { conflict: true, serverVersion: serverRecord.sync_version };
    }

    const nextVersion = serverRecord.sync_version + 1;
    const now = new Date().toISOString();

    switch (table) {
        case 'meditation_goals':
            await db.prepare(`
                UPDATE meditation_goals 
                SET current_count = ?, status = ?, updated_at = ?, sync_version = ?
                WHERE id = ? AND username = ?
            `).bind(data.current_count, data.status, now, nextVersion, data.id, username).run();
            break;

        case 'meditation_records':
            await db.prepare(`
                UPDATE meditation_records 
                SET duration = ?, chant_count = ?, local_time = ?, timezone_offset_minutes = ?, notes = ?, sync_version = ?
                WHERE id = ? AND username = ?
            `).bind(
                data.duration,
                data.chant_count,
                data.local_time || data.localTime || null,
                data.timezone_offset_minutes || data.timezoneOffsetMinutes || null,
                data.notes,
                nextVersion,
                data.id,
                username
            ).run();
            break;
    }

    return { conflict: false, version: nextVersion };
}

// 内部函数：处理删除
async function handleDelete(db, username, table, recordId) {
    await db.prepare(`
        DELETE FROM ${table} WHERE id = ? AND username = ?
    `).bind(recordId, username).run();
}
