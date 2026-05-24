import { jsonResponse } from '../utils/response.js';

function normalizeUserId(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function isMissingUserIdColumnError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('no such column') ||
        message.includes('has no column named');
}

async function resolveUserIdByUsername(db, username) {
    if (!username) return null;
    try {
        const row = await db.prepare(`
      SELECT id
      FROM users
      WHERE username = ?
    `).bind(username).first();
        return normalizeUserId(row?.id);
    } catch (_) {
        return null;
    }
}

function hasStableUserId(auth) {
    return Number.isFinite(auth?.userId);
}

function userScope(auth, tableAlias = '') {
    const prefix = tableAlias ? `${tableAlias}.` : '';
    if (hasStableUserId(auth)) {
        return {
            where: `(${prefix}user_id = ? OR (${prefix}user_id IS NULL AND ${prefix}username = ?))`,
            params: [auth.userId, auth.username],
            stable: true
        };
    }
    return {
        where: `${prefix}username = ?`,
        params: [auth.username],
        stable: false
    };
}

function usernameScope(auth, tableAlias = '') {
    const prefix = tableAlias ? `${tableAlias}.` : '';
    return {
        where: `${prefix}username = ?`,
        params: [auth.username],
        stable: false
    };
}

async function withUserScope(db, auth, build, mode = 'all') {
    const run = async (scope) => {
        const { sql, params } = build(scope);
        const statement = db.prepare(sql).bind(...params);
        if (mode === 'first') return await statement.first();
        if (mode === 'run') return await statement.run();
        return await statement.all();
    };

    const scope = userScope(auth);
    try {
        return await run(scope);
    } catch (error) {
        if (!scope.stable || !isMissingUserIdColumnError(error)) {
            throw error;
        }
        return await run(usernameScope(auth));
    }
}

async function backfillMeditationUserId(db, auth) {
    if (!hasStableUserId(auth)) return;

    const backfill = async (sql) => {
        try {
            await db.prepare(sql).bind(auth.userId, auth.username).run();
        } catch (error) {
            if (!isMissingUserIdColumnError(error)) {
                console.warn('meditation user_id backfill skipped:', error?.message || error);
            }
        }
    };

    await Promise.all([
        backfill(`
      UPDATE meditation_records
      SET user_id = ?
      WHERE user_id IS NULL AND username = ?
    `),
        backfill(`
      UPDATE meditation_goals
      SET user_id = ?
      WHERE user_id IS NULL AND username = ?
    `),
        backfill(`
      UPDATE meditation_settings
      SET user_id = ?
      WHERE user_id IS NULL AND username = ?
    `)
    ]);
}

// 验证认证Token并获取用户名
async function authenticateUser(request, db) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { error: '未授权访问', status: 401 };
    }

    const token = authHeader.substring(7);

    try {
        // 解析JWT token获取用户名
        const parts = token.split('.');
        if (parts.length !== 3) {
            return { error: 'Token格式无效', status: 401 };
        }

        const payload = JSON.parse(atob(parts[1]));
        const username = payload.username || payload.sub;

        if (!username) {
            return { error: '无法获取用户信息', status: 401 };
        }

        const tokenUserId = normalizeUserId(payload.userId ?? payload.user_id ?? payload.id);
        const userId = tokenUserId ?? await resolveUserIdByUsername(db, username);
        const auth = { username, userId };
        await backfillMeditationUserId(db, auth);
        return auth;
    } catch (e) {
        return { error: 'Token解析失败', status: 401 };
    }
}

function asInt(value, fallback = 0) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function parseLocalTime(value, fallbackDate = new Date()) {
    if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) {
        return value;
    }

    const hour = String(fallbackDate.getHours()).padStart(2, '0');
    const minute = String(fallbackDate.getMinutes()).padStart(2, '0');
    return `${hour}:${minute}`;
}

function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

function daysBetween(startDate, endDate) {
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    return Math.max(0, Math.floor((end - start) / 86400000) + 1);
}

async function getNextSyncVersion(db, username) {
    const versionResult = await db.prepare(`
      SELECT COALESCE(MAX(sync_version), 0) + 1 as next_version FROM (
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

    return versionResult?.next_version || 1;
}

async function clearPracticeCaches(env) {
    await Promise.allSettled([
        env.USERS_KV?.delete('leaderboard:cache'),
        env.USERS_KV?.delete('leaderboard:cache:v2'),
        env.USERS_KV?.delete('leaderboard:practice:v2'),
        env.USERS_KV?.delete('leaderboard:practice:v3'),
        env.USERS_KV?.delete('leaderboard:practice:v4')
    ]);
}

async function updateGoalProgress(db, auth, sutraName, delta, syncVersion, now) {
    if (!sutraName || !delta) {
        return;
    }

    await withUserScope(db, auth, (scope) => ({
        sql: `
      UPDATE meditation_goals
      SET current_count = CASE
            WHEN current_count + ? < 0 THEN 0
            ELSE current_count + ?
          END,
          updated_at = ?,
          sync_version = ?
      WHERE ${scope.where} AND sutra_name = ? AND status = 'active'
    `,
        params: [delta, delta, now, syncVersion, ...scope.params, sutraName]
    }), 'run');
}

function resolveRecordId(request, body = null) {
    const url = new URL(request.url);
    return asInt(url.searchParams.get('id') || body?.id);
}

async function ensureOwnerMembershipActive(db, groupId, ownerUsername = null) {
    const resolvedOwnerUsername = ownerUsername || (await db.prepare(`
      SELECT owner_username
      FROM meditation_groups
      WHERE id = ?
    `).bind(groupId).first())?.owner_username;

    if (!resolvedOwnerUsername) {
        return null;
    }

    const now = new Date().toISOString();
    const ownerMembership = await db.prepare(`
      SELECT id, status, role
      FROM meditation_group_members
      WHERE group_id = ? AND username = ?
    `).bind(groupId, resolvedOwnerUsername).first();

    if (!ownerMembership) {
        await db.prepare(`
      INSERT INTO meditation_group_members (
        group_id, username, role, status,
        cumulative_missed_days, consecutive_missed_days,
        warning_message, removal_reason, removed_at,
        joined_at, updated_at
      )
      VALUES (?, ?, 'owner', 'active', 0, 0, NULL, NULL, NULL, ?, ?)
    `).bind(groupId, resolvedOwnerUsername, now, now).run();
        return resolvedOwnerUsername;
    }

    if (ownerMembership.role !== 'owner' || ownerMembership.status !== 'active') {
        await db.prepare(`
      UPDATE meditation_group_members
      SET role = 'owner',
          status = 'active',
          cumulative_missed_days = 0,
          consecutive_missed_days = 0,
          warning_message = NULL,
          removal_reason = NULL,
          removed_at = NULL,
          updated_at = ?
      WHERE id = ?
    `).bind(now, ownerMembership.id).run();
    }

    return resolvedOwnerUsername;
}

async function restoreOwnerMemberships(db, username) {
    const ownedGroups = await db.prepare(`
      SELECT id
      FROM meditation_groups
      WHERE owner_username = ?
    `).bind(username).all();

    for (const group of ownedGroups.results || []) {
        await ensureOwnerMembershipActive(db, group.id, username);
    }
}

async function refreshGroupsForUser(db, username) {
    await restoreOwnerMemberships(db, username);

    const memberships = await db.prepare(`
      SELECT m.group_id
      FROM meditation_group_members m
      JOIN meditation_groups g ON g.id = m.group_id
      WHERE m.username = ? AND m.status = 'active'
    `).bind(username).all();

    for (const membership of memberships.results || []) {
        await evaluateGroupMembers(db, membership.group_id, username);
    }
}

async function evaluateGroupMembers(db, groupId, onlyUsername = null) {
    const group = await db.prepare(`
      SELECT id, owner_username, daily_goal_minutes, cumulative_miss_limit, consecutive_miss_limit
      FROM meditation_groups
      WHERE id = ?
    `).bind(groupId).first();

    if (!group || !group.daily_goal_minutes || group.daily_goal_minutes <= 0) {
        return;
    }

    await ensureOwnerMembershipActive(db, groupId, group.owner_username);

    const today = formatDate(new Date());
    const yesterday = formatDate(addDays(new Date(), -1));
    let memberQuery = `
      SELECT id, username, joined_at, role
      FROM meditation_group_members
      WHERE group_id = ? AND status = 'active' AND role != 'owner'
    `;
    const memberParams = [groupId];
    if (onlyUsername) {
        memberQuery += ` AND username = ?`;
        memberParams.push(onlyUsername);
    }

    const members = await db.prepare(memberQuery).bind(...memberParams).all();
    for (const member of members.results || []) {
        const joinedDate = (member.joined_at || today).split('T')[0];
        const trackedStart = joinedDate;
        const trackedDays = joinedDate > yesterday ? 0 : daysBetween(trackedStart, yesterday);

        let cumulativeMissed = 0;
        let consecutiveMissed = 0;
        let trailingMissed = 0;

        if (trackedDays > 0) {
            const result = await db.prepare(`
        SELECT record_date, SUM(COALESCE(duration, 0)) as duration
        FROM meditation_records
        WHERE username = ? AND record_date >= ? AND record_date <= ?
        GROUP BY record_date
      `).bind(member.username, trackedStart, yesterday).all();

            const durationByDate = new Map(
                (result.results || []).map(row => [row.record_date, row.duration || 0])
            );

            for (let i = 0; i < trackedDays; i++) {
                const date = formatDate(addDays(new Date(`${trackedStart}T00:00:00Z`), i));
                if ((durationByDate.get(date) || 0) < group.daily_goal_minutes) {
                    cumulativeMissed++;
                    trailingMissed++;
                } else {
                    trailingMissed = 0;
                }
            }
            consecutiveMissed = trailingMissed;
        }

        const todayDurationRow = await db.prepare(`
      SELECT SUM(COALESCE(duration, 0)) as duration
      FROM meditation_records
      WHERE username = ? AND record_date = ?
    `).bind(member.username, today).first();
        const todayComplete = (todayDurationRow?.duration || 0) >= group.daily_goal_minutes;
        if (todayComplete) {
            consecutiveMissed = 0;
        }

        const cumulativeLimit = group.cumulative_miss_limit || 0;
        const consecutiveLimit = group.consecutive_miss_limit || 0;
        const shouldRemove =
            (cumulativeLimit > 0 && cumulativeMissed >= cumulativeLimit) ||
            (consecutiveLimit > 0 && consecutiveMissed >= consecutiveLimit);

        if (shouldRemove) {
            const reason = cumulativeLimit > 0 && cumulativeMissed >= cumulativeLimit
                ? `累计未达标 ${cumulativeMissed} 天`
                : `连续未达标 ${consecutiveMissed} 天`;
            await db.prepare(`
        UPDATE meditation_group_members
        SET status = 'removed',
            cumulative_missed_days = ?,
            consecutive_missed_days = ?,
            warning_message = NULL,
            removed_at = ?,
            removal_reason = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(cumulativeMissed, consecutiveMissed, new Date().toISOString(), reason, new Date().toISOString(), member.id).run();
            continue;
        }

        let warningMessage = null;
        if (!todayComplete) {
            if (consecutiveLimit > 1 && consecutiveMissed >= consecutiveLimit - 1) {
                warningMessage = `连续未达标已接近清退规则，今日完成 ${group.daily_goal_minutes} 分钟后恢复`;
            } else if (cumulativeLimit > 1 && cumulativeMissed >= cumulativeLimit - 1) {
                warningMessage = `累计未达标已接近清退规则，今日完成 ${group.daily_goal_minutes} 分钟后恢复`;
            }
        }

        await db.prepare(`
      UPDATE meditation_group_members
      SET cumulative_missed_days = ?,
          consecutive_missed_days = ?,
          warning_message = ?,
          updated_at = ?
      WHERE id = ?
    `).bind(cumulativeMissed, consecutiveMissed, warningMessage, new Date().toISOString(), member.id).run();
    }
}

function mapGroupRow(row) {
    return {
        id: row.id,
        name: row.name,
        description: row.description || '',
        ownerUsername: row.owner_username,
        ownerName: row.owner_nickname || row.owner_username,
        requireApproval: row.require_approval === 1 || row.require_approval === true,
        dailyGoalMinutes: row.daily_goal_minutes || 0,
        cumulativeMissLimit: row.cumulative_miss_limit || 0,
        consecutiveMissLimit: row.consecutive_miss_limit || 0,
        memberCount: row.member_count || row.memberCount || 0,
        pendingCount: row.pending_count || row.pendingCount || 0,
        totalDuration: row.total_duration || row.totalDuration || 0,
        todayDuration: row.today_duration || row.todayDuration || 0,
        myStatus: row.my_status || null,
        myRole: row.my_role || null,
        myWarningMessage: row.my_warning_message || null,
        createdAt: row.created_at || null
    };
}

function parseGroupSearchQuery(query) {
    const raw = (query || '').trim();
    if (!raw) {
        return { text: '', groupId: null };
    }

    const normalized = raw.startsWith('#') ? raw.slice(1).trim() : raw;
    const numericId = /^\d+$/.test(normalized) ? asInt(normalized) : null;

    return {
        text: raw,
        groupId: numericId && numericId > 0 ? numericId : null
    };
}

function normalizePlainText(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeForMatching(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, '')
        .trim();
}

function firstTextLine(text, fallback = '功课本') {
    const line = normalizePlainText(text)
        .split('\n')
        .map((item) => item.trim())
        .find((item) => item.length > 0);
    if (!line) return fallback;
    const cleaned = line.replace(/^[#>\s]+/, '').trim();
    if (!cleaned) return fallback;
    return cleaned.length > 32 ? cleaned.slice(0, 32) : cleaned;
}

async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(String(text || ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function ownerObjectSegment(auth) {
    const value = hasStableUserId(auth) ? `u-${auth.userId}` : `name-${auth.username}`;
    return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

function parseIsoOrNow(value, fallback = new Date()) {
    const parsed = value ? new Date(value) : null;
    return parsed && !Number.isNaN(parsed.getTime())
        ? parsed.toISOString()
        : fallback.toISOString();
}

function toPracticeBookRow(row, content = {}) {
    return {
        id: row.id,
        practiceTitle: row.practice_title,
        title: row.title,
        sourceType: row.source_type,
        sourceUrl: row.source_url || null,
        sourceFileName: row.source_file_name || null,
        contentHash: row.content_hash,
        plainText: content.plainText || '',
        normalizedText: content.normalizedText || row.normalized_text || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        syncStatus: 'synced',
        remoteObjectKey: row.remote_object_key || null,
        isActive: row.is_active === 1 || row.is_active === true
    };
}

async function readPracticeBookContent(env, objectKey) {
    if (!env.R2_BUCKET || !objectKey) return {};
    const object = await env.R2_BUCKET.get(objectKey);
    if (!object) return {};
    try {
        return JSON.parse(await object.text());
    } catch (_) {
        return {};
    }
}

async function buildPracticeBookFromBody(body, auth, fallback = {}) {
    const now = new Date();
    const id = String(body.id || fallback.id || crypto.randomUUID());
    const practiceTitle = String(body.practiceTitle || body.practice_title || fallback.practiceTitle || '').trim();
    const plainText = normalizePlainText(body.plainText || body.plain_text || fallback.plainText || '');
    const title = String(body.title || fallback.title || firstTextLine(plainText)).trim();
    const sourceType = String(body.sourceType || body.source_type || fallback.sourceType || 'manual');
    const normalizedText = normalizeForMatching(body.normalizedText || body.normalized_text || plainText);
    const contentHash = String(body.contentHash || body.content_hash || await sha256Hex(plainText));
    const remoteObjectKey = String(
        body.remoteObjectKey ||
        body.remote_object_key ||
        `practice-books/${ownerObjectSegment(auth)}/${id}.json`
    );

    if (!practiceTitle) {
        throw new Error('practiceTitle required');
    }
    if (!title) {
        throw new Error('title required');
    }
    if (plainText.length < 2 || normalizedText.length < 2) {
        throw new Error('plainText required');
    }

    return {
        id,
        practiceTitle,
        title,
        sourceType,
        sourceUrl: body.sourceUrl || body.source_url || fallback.sourceUrl || null,
        sourceFileName: body.sourceFileName || body.source_file_name || fallback.sourceFileName || null,
        contentHash,
        plainText,
        normalizedText,
        createdAt: parseIsoOrNow(body.createdAt || body.created_at || fallback.createdAt, now),
        updatedAt: now.toISOString(),
        remoteObjectKey,
        isActive: body.isActive !== false && body.is_active !== 0
    };
}

async function savePracticeBookForAuth(db, env, auth, book) {
    if (!env.R2_BUCKET) {
        throw new Error('R2_BUCKET not configured');
    }

    const objectPayload = {
        id: book.id,
        practiceTitle: book.practiceTitle,
        title: book.title,
        sourceType: book.sourceType,
        sourceUrl: book.sourceUrl,
        sourceFileName: book.sourceFileName,
        contentHash: book.contentHash,
        plainText: book.plainText,
        normalizedText: book.normalizedText,
        createdAt: book.createdAt,
        updatedAt: book.updatedAt
    };

    await env.R2_BUCKET.put(book.remoteObjectKey, JSON.stringify(objectPayload), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });

    const scope = userScope(auth);
    await db.prepare(`
      UPDATE practice_books
      SET is_active = 0,
          updated_at = ?
      WHERE ${scope.where} AND practice_title = ?
    `).bind(book.updatedAt, ...scope.params, book.practiceTitle).run();

    const nextVersion = await getNextSyncVersion(db, auth.username);
    await db.prepare(`
      INSERT INTO practice_books (
        id, username, user_id, practice_title, title, source_type,
        source_url, source_file_name, content_hash, normalized_text,
        remote_object_key, is_active, created_at, updated_at, sync_version
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        user_id = excluded.user_id,
        practice_title = excluded.practice_title,
        title = excluded.title,
        source_type = excluded.source_type,
        source_url = excluded.source_url,
        source_file_name = excluded.source_file_name,
        content_hash = excluded.content_hash,
        normalized_text = excluded.normalized_text,
        remote_object_key = excluded.remote_object_key,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at,
        sync_version = excluded.sync_version
    `).bind(
        book.id,
        auth.username,
        auth.userId,
        book.practiceTitle,
        book.title,
        book.sourceType,
        book.sourceUrl,
        book.sourceFileName,
        book.contentHash,
        book.normalizedText,
        book.remoteObjectKey,
        book.isActive ? 1 : 0,
        book.createdAt,
        book.updatedAt,
        nextVersion
    ).run();

    return { ...book, syncStatus: 'synced' };
}

function decodeHtmlEntities(text) {
    const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' '
    };
    return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
            return String.fromCodePoint(parseInt(entity.slice(2), 16));
        }
        if (entity.startsWith('#')) {
            return String.fromCodePoint(parseInt(entity.slice(1), 10));
        }
        return named[entity] || ' ';
    });
}

function htmlToText(html) {
    return normalizePlainText(
        decodeHtmlEntities(
            String(html || '')
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/(p|div|section|article|h[1-6]|li)>/gi, '\n')
                .replace(/<[^>]+>/g, ' ')
        ).replace(/[ \t]{2,}/g, ' ')
    );
}

function extractElementById(html, id) {
    const startPattern = new RegExp(`<([a-zA-Z0-9]+)[^>]*id=["']${id}["'][^>]*>`, 'i');
    const start = startPattern.exec(html);
    if (!start) return null;

    const tag = start[1];
    const contentStart = start.index + start[0].length;
    const tagPattern = new RegExp(`</?${tag}\\b[^>]*>`, 'ig');
    tagPattern.lastIndex = contentStart;
    let depth = 1;
    let match;
    while ((match = tagPattern.exec(html)) !== null) {
        if (match[0][1] === '/') {
            depth -= 1;
            if (depth === 0) {
                return html.slice(contentStart, match.index);
            }
        } else {
            depth += 1;
        }
    }
    return html.slice(contentStart);
}

function extractHtmlTitle(html) {
    const candidates = [
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i,
        /var\s+msg_title\s*=\s*["']([^"']+)["']/i,
        /<title[^>]*>([\s\S]*?)<\/title>/i
    ];
    for (const pattern of candidates) {
        const match = pattern.exec(html);
        if (match?.[1]) {
            return htmlToText(match[1]).slice(0, 80);
        }
    }
    return '功课本';
}

function extractArticleText(html, url) {
    const host = new URL(url).hostname;
    const candidates = [];

    if (host.includes('mp.weixin.qq.com')) {
        const wechatContent = extractElementById(html, 'js_content');
        if (wechatContent) candidates.push(wechatContent);
    }

    const richMedia = extractElementById(html, 'img-content') ||
        extractElementById(html, 'js_article') ||
        extractElementById(html, 'article-content');
    if (richMedia) candidates.push(richMedia);

    const articleMatch = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html);
    if (articleMatch?.[1]) candidates.push(articleMatch[1]);

    const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    if (bodyMatch?.[1]) candidates.push(bodyMatch[1]);

    return candidates
        .map(htmlToText)
        .sort((a, b) => b.length - a.length)[0] || '';
}

// 功课本列表 GET /api/meditation/practice-books
export async function handleGetPracticeBooks(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const url = new URL(request.url);
        const practiceTitle = url.searchParams.get('practiceTitle');
        const result = await withUserScope(db, auth, (scope) => {
            let sql = `
      SELECT id, username, user_id, practice_title, title, source_type,
             source_url, source_file_name, content_hash, normalized_text,
             remote_object_key, is_active, created_at, updated_at
      FROM practice_books
      WHERE ${scope.where}
    `;
            const params = [...scope.params];
            if (practiceTitle) {
                sql += ' AND practice_title = ?';
                params.push(practiceTitle);
            }
            sql += ' ORDER BY updated_at DESC';
            return { sql, params };
        });

        const books = [];
        for (const row of result.results || []) {
            const content = await readPracticeBookContent(env, row.remote_object_key);
            books.push(toPracticeBookRow(row, content));
        }

        return jsonResponse({ success: true, data: { books } });
    } catch (e) {
        console.error('获取功课本失败:', e);
        return jsonResponse({ success: false, error: '获取功课本失败' }, 500);
    }
}

// 保存功课本 POST /api/meditation/practice-books
export async function handleSavePracticeBook(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const body = await request.json();
        const book = await buildPracticeBookFromBody(body, auth);
        const saved = await savePracticeBookForAuth(db, env, auth, book);
        return jsonResponse({ success: true, data: { book: saved } });
    } catch (e) {
        console.error('保存功课本失败:', e);
        return jsonResponse({ success: false, error: '保存功课本失败: ' + e.message }, 500);
    }
}

// 删除功课本 DELETE /api/meditation/practice-books?id=...
export async function handleDeletePracticeBook(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const url = new URL(request.url);
        const id = url.searchParams.get('id');
        if (!id) {
            return jsonResponse({ success: false, error: 'id required' }, 400);
        }

        const row = await withUserScope(db, auth, (scope) => ({
            sql: `
      SELECT id, remote_object_key
      FROM practice_books
      WHERE id = ? AND ${scope.where}
    `,
            params: [id, ...scope.params]
        }), 'first');

        if (!row) {
            return jsonResponse({ success: false, error: '功课本不存在' }, 404);
        }

        await db.prepare('DELETE FROM practice_books WHERE id = ?').bind(id).run();
        if (env.R2_BUCKET && row.remote_object_key) {
            await env.R2_BUCKET.delete(row.remote_object_key);
        }

        return jsonResponse({ success: true });
    } catch (e) {
        console.error('删除功课本失败:', e);
        return jsonResponse({ success: false, error: '删除功课本失败' }, 500);
    }
}

// 导入链接 POST /api/meditation/practice-books/import-url
export async function handleImportPracticeBookUrl(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const body = await request.json();
        const sourceUrl = String(body.url || body.sourceUrl || '').trim();
        const practiceTitle = String(body.practiceTitle || '').trim();
        if (!/^https?:\/\//i.test(sourceUrl)) {
            return jsonResponse({ success: false, error: '请输入 http/https 链接' }, 400);
        }

        const remote = await fetch(sourceUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0 FabushiPracticeBookImporter',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        if (!remote.ok) {
            return jsonResponse({
                success: false,
                error: `链接抓取失败: HTTP ${remote.status}`,
                needsWebViewFallback: true
            }, 422);
        }

        const html = await remote.text();
        const plainText = extractArticleText(html, sourceUrl);
        if (plainText.length < 40) {
            return jsonResponse({
                success: false,
                error: '云端未能提取正文，可改用 App 内页面提取',
                needsWebViewFallback: true
            }, 422);
        }

        const book = await buildPracticeBookFromBody({
            practiceTitle,
            title: extractHtmlTitle(html) || firstTextLine(plainText),
            sourceType: 'url',
            sourceUrl,
            plainText
        }, auth);
        const saved = await savePracticeBookForAuth(db, env, auth, book);
        return jsonResponse({ success: true, data: { book: saved } });
    } catch (e) {
        console.error('链接导入功课本失败:', e);
        return jsonResponse({
            success: false,
            error: '链接解析失败',
            needsWebViewFallback: true
        }, 422);
    }
}

// 离线 ASR 模型包 manifest GET /api/meditation/asr-model-manifest
export async function handleAsrModelManifest(request, env) {
    const modelId = 'streaming-paraformer-zh-en';
    const makeR2Url = (fileName) => {
        const url = new URL('/r2', request.url);
        url.searchParams.set('file', `asr-models/${modelId}/${fileName}`);
        return url.toString();
    };

    return jsonResponse({
        success: true,
        id: modelId,
        version: '2026-05-24-paraformer-int8',
        provider: 'sherpa_onnx_paraformer',
        offline: true,
        files: [
            {
                name: 'encoder.int8.onnx',
                url: makeR2Url('encoder.int8.onnx'),
                minBytes: 1048576,
                sha256: env.ASR_PARA_FORMER_ENCODER_SHA256 || null
            },
            {
                name: 'decoder.int8.onnx',
                url: makeR2Url('decoder.int8.onnx'),
                minBytes: 524288,
                sha256: env.ASR_PARA_FORMER_DECODER_SHA256 || null
            },
            {
                name: 'tokens.txt',
                url: makeR2Url('tokens.txt'),
                minBytes: 1024,
                sha256: env.ASR_PARA_FORMER_TOKENS_SHA256 || null
            }
        ]
    });
}

// 同步修行记录 POST /api/meditation/record
export async function handleSyncRecord(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const body = await request.json();
        const {
            sutra,
            sutraSource = 'custom',
            duration = 0,
            chantCount = 0,
            notes = '',
            isManual = false,
            recordDate,
            localTime,
            timezoneOffsetMinutes = null,
            startTime = null,
            endTime = null
        } = body;

        if (!sutra) {
            return jsonResponse({ success: false, error: '功课名称不能为空' }, 400);
        }

        const now = new Date().toISOString();
        const date = recordDate || now.split('T')[0];
        const localClock = parseLocalTime(localTime, new Date());
        const resolvedDuration = Math.max(0, asInt(duration, 0));
        const resolvedChantCount = Math.max(0, asInt(chantCount, 0));
        const nextVersion = await getNextSyncVersion(db, auth.username);

        const insertWithoutUserId = () => db.prepare(`
      INSERT INTO meditation_records (
        username, sutra_name, sutra_source, duration, chant_count, record_date,
        local_time, timezone_offset_minutes, start_time, end_time,
        is_manual, notes, created_at, sync_version
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
            auth.username,
            sutra,
            sutraSource,
            resolvedDuration,
            resolvedChantCount,
            date,
            localClock,
            timezoneOffsetMinutes,
            startTime,
            endTime,
            isManual ? 1 : 0,
            notes,
            now,
            nextVersion
        ).run();

        let insertResult;
        if (hasStableUserId(auth)) {
            try {
                insertResult = await db.prepare(`
      INSERT INTO meditation_records (
        username, user_id, sutra_name, sutra_source, duration, chant_count, record_date,
        local_time, timezone_offset_minutes, start_time, end_time,
        is_manual, notes, created_at, sync_version
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
                    auth.username,
                    auth.userId,
                    sutra,
                    sutraSource,
                    resolvedDuration,
                    resolvedChantCount,
                    date,
                    localClock,
                    timezoneOffsetMinutes,
                    startTime,
                    endTime,
                    isManual ? 1 : 0,
                    notes,
                    now,
                    nextVersion
                ).run();
            } catch (error) {
                if (!isMissingUserIdColumnError(error)) throw error;
                insertResult = await insertWithoutUserId();
            }
        } else {
            insertResult = await insertWithoutUserId();
        }

        // 更新发愿目标进度
        await updateGoalProgress(db, auth, sutra, resolvedChantCount, nextVersion + 1, now);

        await clearPracticeCaches(env);
        await refreshGroupsForUser(db, auth.username);

        return jsonResponse({
            success: true,
            message: '修行记录已同步',
            recordId: insertResult.meta?.last_row_id || null
        });
    } catch (e) {
        console.error('同步修行记录失败:', e);
        return jsonResponse({ success: false, error: '同步失败: ' + e.message }, 500);
    }
}

// 获取修行记录列表 GET /api/meditation/records
export async function handleGetRecords(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const url = new URL(request.url);
        const requestedLimit = parseInt(url.searchParams.get('limit') || '50');
        const requestedOffset = parseInt(url.searchParams.get('offset') || '0');
        const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
        const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
        const sutra = url.searchParams.get('sutra');

        const [result, totalResult] = await Promise.all([
            withUserScope(db, auth, (scope) => {
                let sql = `
      SELECT id, sutra_name, sutra_source, duration, chant_count, record_date,
             local_time, timezone_offset_minutes, start_time, end_time,
             is_manual, notes, created_at
      FROM meditation_records
      WHERE ${scope.where}
    `;
                const params = [...scope.params];
                if (sutra) {
                    sql += ` AND sutra_name = ?`;
                    params.push(sutra);
                }
                sql += ` ORDER BY record_date DESC, created_at DESC LIMIT ? OFFSET ?`;
                params.push(limit, offset);
                return { sql, params };
            }),
            withUserScope(db, auth, (scope) => {
                let sql = `
      SELECT COUNT(*) as total
      FROM meditation_records
      WHERE ${scope.where}
    `;
                const params = [...scope.params];
                if (sutra) {
                    sql += ` AND sutra_name = ?`;
                    params.push(sutra);
                }
                return { sql, params };
            }, 'first')
        ]);

        return jsonResponse({
            success: true,
            data: {
                records: result.results || [],
                total: totalResult?.total || 0
            }
        });
    } catch (e) {
        console.error('获取修行记录失败:', e);
        return jsonResponse({ success: false, error: '获取记录失败' }, 500);
    }
}

// 更新修行记录 PUT /api/meditation/records?id=123
export async function handleUpdateRecord(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const body = await request.json();
        const recordId = resolveRecordId(request, body);
        if (!recordId) {
            return jsonResponse({ success: false, error: 'recordId required' }, 400);
        }

        const existing = await withUserScope(db, auth, (scope) => ({
            sql: `
      SELECT id, sutra_name, sutra_source, duration, chant_count, record_date,
             local_time, timezone_offset_minutes, start_time, end_time,
             is_manual, notes
      FROM meditation_records
      WHERE id = ? AND ${scope.where}
    `,
            params: [recordId, ...scope.params]
        }), 'first');

        if (!existing) {
            return jsonResponse({ success: false, error: '记录不存在' }, 404);
        }

        const now = new Date().toISOString();
        const resolvedSutra = (body.sutra ?? existing.sutra_name ?? '').toString().trim();
        if (!resolvedSutra) {
            return jsonResponse({ success: false, error: '功课名称不能为空' }, 400);
        }

        const resolvedSutraSource = (body.sutraSource ?? existing.sutra_source ?? 'custom').toString();
        const resolvedDuration = Math.max(0, asInt(body.duration, existing.duration || 0));
        const resolvedChantCount = Math.max(0, asInt(body.chantCount, existing.chant_count || 0));
        const resolvedRecordDate = (body.recordDate || existing.record_date || formatDate(new Date())).toString();
        const resolvedLocalTime = parseLocalTime(body.localTime || existing.local_time, new Date());
        const resolvedTimezoneOffsetMinutes = body.timezoneOffsetMinutes ?? existing.timezone_offset_minutes ?? null;
        const resolvedStartTime = body.startTime ?? existing.start_time ?? null;
        const resolvedEndTime = body.endTime ?? existing.end_time ?? null;
        const resolvedIsManual = body.isManual === undefined
            ? (existing.is_manual === 1 || existing.is_manual === true)
            : body.isManual === true;
        const resolvedNotes = (body.notes ?? existing.notes ?? '').toString();
        const nextVersion = await getNextSyncVersion(db, auth.username);

        await withUserScope(db, auth, (scope) => ({
            sql: `
      UPDATE meditation_records
      SET sutra_name = ?,
          sutra_source = ?,
          duration = ?,
          chant_count = ?,
          record_date = ?,
          local_time = ?,
          timezone_offset_minutes = ?,
          start_time = ?,
          end_time = ?,
          is_manual = ?,
          notes = ?,
          sync_version = ?
      WHERE id = ? AND ${scope.where}
    `,
            params: [
                resolvedSutra,
                resolvedSutraSource,
                resolvedDuration,
                resolvedChantCount,
                resolvedRecordDate,
                resolvedLocalTime,
                resolvedTimezoneOffsetMinutes,
                resolvedStartTime,
                resolvedEndTime,
                resolvedIsManual ? 1 : 0,
                resolvedNotes,
                nextVersion,
                recordId,
                ...scope.params
            ]
        }), 'run');

        let goalVersion = nextVersion + 1;
        if (existing.sutra_name === resolvedSutra) {
            const delta = resolvedChantCount - (existing.chant_count || 0);
            await updateGoalProgress(db, auth, resolvedSutra, delta, goalVersion, now);
        } else {
            await updateGoalProgress(db, auth, existing.sutra_name, -(existing.chant_count || 0), goalVersion, now);
            goalVersion += 1;
            await updateGoalProgress(db, auth, resolvedSutra, resolvedChantCount, goalVersion, now);
        }

        await clearPracticeCaches(env);
        await refreshGroupsForUser(db, auth.username);

        return jsonResponse({
            success: true,
            message: '修行记录已更新',
            data: {
                id: recordId,
                sutra: resolvedSutra,
                chantCount: resolvedChantCount,
                duration: resolvedDuration,
                recordDate: resolvedRecordDate,
                localTime: resolvedLocalTime,
                notes: resolvedNotes,
            },
        });
    } catch (e) {
        console.error('更新修行记录失败:', e);
        return jsonResponse({ success: false, error: '更新记录失败: ' + e.message }, 500);
    }
}

// 删除修行记录 DELETE /api/meditation/records?id=123
export async function handleDeleteRecord(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        let body = null;
        if (request.headers.get('Content-Type')?.includes('application/json')) {
            try {
                body = await request.json();
            } catch (_) {
                body = null;
            }
        }

        const recordId = resolveRecordId(request, body);
        if (!recordId) {
            return jsonResponse({ success: false, error: 'recordId required' }, 400);
        }

        const existing = await withUserScope(db, auth, (scope) => ({
            sql: `
      SELECT id, sutra_name, chant_count
      FROM meditation_records
      WHERE id = ? AND ${scope.where}
    `,
            params: [recordId, ...scope.params]
        }), 'first');

        if (!existing) {
            return jsonResponse({ success: false, error: '记录不存在' }, 404);
        }

        const now = new Date().toISOString();
        const nextVersion = await getNextSyncVersion(db, auth.username);

        await withUserScope(db, auth, (scope) => ({
            sql: `
      DELETE FROM meditation_records
      WHERE id = ? AND ${scope.where}
    `,
            params: [recordId, ...scope.params]
        }), 'run');

        await updateGoalProgress(
            db,
            auth,
            existing.sutra_name,
            -(existing.chant_count || 0),
            nextVersion + 1,
            now,
        );

        await clearPracticeCaches(env);
        await refreshGroupsForUser(db, auth.username);

        return jsonResponse({ success: true, message: '修行记录已删除' });
    } catch (e) {
        console.error('删除修行记录失败:', e);
        return jsonResponse({ success: false, error: '删除记录失败: ' + e.message }, 500);
    }
}

// 搜索/查看共修小组 GET /api/meditation/groups
export async function handleGetMeditationGroups(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        await refreshGroupsForUser(db, auth.username);

        const url = new URL(request.url);
        const search = parseGroupSearchQuery(url.searchParams.get('query') || '');
        const requestedLimit = parseInt(url.searchParams.get('limit') || '30');
        const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 30;
        const today = formatDate(new Date());
        const params = [today, auth.username];
        let whereClause = '';

        if (search.text) {
            whereClause = `
        WHERE g.name LIKE ?
           OR g.description LIKE ?
           OR g.owner_username LIKE ?
           OR COALESCE(owner.nickname, '') LIKE ?
      `;
            params.push(`%${search.text}%`, `%${search.text}%`, `%${search.text}%`, `%${search.text}%`);
            if (search.groupId) {
                whereClause += ` OR g.id = ?`;
                params.push(search.groupId);
            }
        }

        params.push(limit);

        const result = await db.prepare(`
      SELECT
        g.*,
        owner.nickname as owner_nickname,
        my.status as my_status,
        my.role as my_role,
        my.warning_message as my_warning_message,
        (
          SELECT COUNT(*)
          FROM meditation_group_members m
          WHERE m.group_id = g.id AND m.status = 'pending'
        ) as pending_count,
        (
          SELECT COUNT(*)
          FROM meditation_group_members m
          WHERE m.group_id = g.id AND m.status = 'active'
        ) as member_count,
        (
          SELECT COALESCE(SUM(COALESCE(r.duration, 0)), 0)
          FROM meditation_group_members m
          LEFT JOIN meditation_records r ON r.username = m.username
          WHERE m.group_id = g.id AND m.status = 'active'
        ) as total_duration,
        (
          SELECT COALESCE(SUM(COALESCE(r.duration, 0)), 0)
          FROM meditation_group_members m
          LEFT JOIN meditation_records r ON r.username = m.username AND r.record_date = ?
          WHERE m.group_id = g.id AND m.status = 'active'
        ) as today_duration
      FROM meditation_groups g
      LEFT JOIN users owner ON owner.username = g.owner_username
      LEFT JOIN meditation_group_members my ON my.group_id = g.id AND my.username = ?
      ${whereClause}
      ORDER BY
        CASE WHEN my.status = 'active' THEN 0 WHEN my.status = 'pending' THEN 1 ELSE 2 END,
        member_count DESC,
        g.created_at DESC
      LIMIT ?
    `).bind(...params).all();

        return jsonResponse({
            success: true,
            data: {
                groups: (result.results || []).map(mapGroupRow)
            }
        });
    } catch (e) {
        console.error('获取共修小组失败:', e);
        return jsonResponse({ success: false, error: '获取共修小组失败' }, 500);
    }
}

// 创建共修小组 POST /api/meditation/groups
export async function handleCreateMeditationGroup(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const body = await request.json();
        const name = (body.name || '').toString().trim();
        if (!name) {
            return jsonResponse({ success: false, error: '小组名称不能为空' }, 400);
        }

        const now = new Date().toISOString();
        const dailyGoalMinutes = Math.max(0, asInt(body.dailyGoalMinutes, 30));
        const cumulativeMissLimit = Math.max(0, asInt(body.cumulativeMissLimit, 7));
        const consecutiveMissLimit = Math.max(0, asInt(body.consecutiveMissLimit, 3));

        const insert = await db.prepare(`
      INSERT INTO meditation_groups (
        name, description, owner_username, require_approval, daily_goal_minutes,
        cumulative_miss_limit, consecutive_miss_limit, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
            name,
            (body.description || '').toString().trim(),
            auth.username,
            body.requireApproval ? 1 : 0,
            dailyGoalMinutes,
            cumulativeMissLimit,
            consecutiveMissLimit,
            now,
            now
        ).run();

        const groupId = insert.meta?.last_row_id;
        await db.prepare(`
      INSERT INTO meditation_group_members (group_id, username, role, status, joined_at, updated_at)
      VALUES (?, ?, 'owner', 'active', ?, ?)
    `).bind(groupId, auth.username, now, now).run();

        return jsonResponse({ success: true, data: { groupId } });
    } catch (e) {
        console.error('创建共修小组失败:', e);
        return jsonResponse({ success: false, error: '创建共修小组失败' }, 500);
    }
}

// 加入共修小组 POST /api/meditation/groups/join
export async function handleJoinMeditationGroup(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const body = await request.json();
        const groupId = asInt(body.groupId);
        if (!groupId) {
            return jsonResponse({ success: false, error: 'groupId required' }, 400);
        }

        const group = await db.prepare(`
      SELECT id, require_approval, owner_username
      FROM meditation_groups
      WHERE id = ?
    `).bind(groupId).first();
        if (!group) {
            return jsonResponse({ success: false, error: '小组不存在' }, 404);
        }

        const now = new Date().toISOString();
        const role = group.owner_username === auth.username ? 'owner' : 'member';
        const status = role === 'owner' || group.require_approval !== 1 ? 'active' : 'pending';

        await db.prepare(`
      INSERT INTO meditation_group_members (group_id, username, role, status, joined_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id, username) DO UPDATE SET
        status = excluded.status,
        role = CASE WHEN meditation_group_members.role = 'owner' THEN 'owner' ELSE excluded.role END,
        warning_message = NULL,
        removal_reason = NULL,
        removed_at = NULL,
        updated_at = excluded.updated_at
    `).bind(groupId, auth.username, role, status, now, now).run();

        return jsonResponse({
            success: true,
            data: {
                status,
                message: status === 'pending' ? '已提交加入申请，等待同意' : '已加入共修小组'
            }
        });
    } catch (e) {
        console.error('加入共修小组失败:', e);
        return jsonResponse({ success: false, error: '加入共修小组失败' }, 500);
    }
}

// 共修小组详情 GET /api/meditation/groups/detail?groupId=1
export async function handleGetMeditationGroupDetail(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const url = new URL(request.url);
        const groupId = asInt(url.searchParams.get('groupId'));
        if (!groupId) {
            return jsonResponse({ success: false, error: 'groupId required' }, 400);
        }

        await restoreOwnerMemberships(db, auth.username);
        await evaluateGroupMembers(db, groupId);

        const today = formatDate(new Date());
        const groupRow = await db.prepare(`
      SELECT
        g.*,
        owner.nickname as owner_nickname,
        my.status as my_status,
        my.role as my_role,
        my.warning_message as my_warning_message,
        (
          SELECT COUNT(*)
          FROM meditation_group_members m
          WHERE m.group_id = g.id AND m.status = 'active'
        ) as member_count,
        (
          SELECT COALESCE(SUM(COALESCE(r.duration, 0)), 0)
          FROM meditation_group_members m
          LEFT JOIN meditation_records r ON r.username = m.username
          WHERE m.group_id = g.id AND m.status = 'active'
        ) as total_duration,
        (
          SELECT COALESCE(SUM(COALESCE(r.duration, 0)), 0)
          FROM meditation_group_members m
          LEFT JOIN meditation_records r ON r.username = m.username AND r.record_date = ?
          WHERE m.group_id = g.id AND m.status = 'active'
        ) as today_duration
      FROM meditation_groups g
      LEFT JOIN users owner ON owner.username = g.owner_username
      LEFT JOIN meditation_group_members my ON my.group_id = g.id AND my.username = ?
      WHERE g.id = ?
    `).bind(today, auth.username, groupId).first();

        if (!groupRow) {
            return jsonResponse({ success: false, error: '小组不存在' }, 404);
        }

        const membersResult = await db.prepare(`
      SELECT
        m.username,
        COALESCE(u.nickname, m.username) as displayName,
        COALESCE(u.avatar, u.alipay_avatar, u.wechat_headimgurl) as avatar,
        m.role,
        m.cumulative_missed_days,
        m.consecutive_missed_days,
        m.warning_message,
        COALESCE(SUM(COALESCE(r.duration, 0)), 0) as totalDuration,
        COALESCE(SUM(CASE WHEN r.record_date = ? THEN COALESCE(r.duration, 0) ELSE 0 END), 0) as todayDuration,
        COUNT(DISTINCT r.record_date) as activeDays
      FROM meditation_group_members m
      LEFT JOIN users u ON u.username = m.username
      LEFT JOIN meditation_records r ON r.username = m.username
      WHERE m.group_id = ? AND m.status = 'active'
      GROUP BY m.username
      ORDER BY totalDuration DESC, todayDuration DESC, activeDays DESC
      LIMIT 100
    `).bind(today, groupId).all();

        const pendingResult = groupRow.owner_username === auth.username
            ? await db.prepare(`
        SELECT m.username, COALESCE(u.nickname, m.username) as displayName, COALESCE(u.avatar, u.alipay_avatar, u.wechat_headimgurl) as avatar, m.updated_at
        FROM meditation_group_members m
        LEFT JOIN users u ON u.username = m.username
        WHERE m.group_id = ? AND m.status = 'pending'
        ORDER BY m.updated_at ASC
      `).bind(groupId).all()
            : { results: [] };

        return jsonResponse({
            success: true,
            data: {
                group: mapGroupRow(groupRow),
                members: (membersResult.results || []).map((member, index) => ({
                    username: member.username,
                    displayName: member.displayName,
                    avatar: member.avatar || null,
                    role: member.role,
                    cumulativeMissedDays: member.cumulative_missed_days || 0,
                    consecutiveMissedDays: member.consecutive_missed_days || 0,
                    warningMessage: member.warning_message || null,
                    totalDuration: member.totalDuration || 0,
                    todayDuration: member.todayDuration || 0,
                    activeDays: member.activeDays || 0,
                    rank: index + 1
                })),
                pendingMembers: pendingResult.results || []
            }
        });
    } catch (e) {
        console.error('获取共修小组详情失败:', e);
        return jsonResponse({ success: false, error: '获取共修小组详情失败' }, 500);
    }
}

// 审核加入申请 POST /api/meditation/groups/review
export async function handleReviewMeditationGroupJoin(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const body = await request.json();
        const groupId = asInt(body.groupId);
        const username = (body.username || '').toString();
        const approve = body.approve === true;
        if (!groupId || !username) {
            return jsonResponse({ success: false, error: '参数不完整' }, 400);
        }

        const group = await db.prepare(`
      SELECT owner_username
      FROM meditation_groups
      WHERE id = ?
    `).bind(groupId).first();
        if (!group) {
            return jsonResponse({ success: false, error: '小组不存在' }, 404);
        }
        if (group.owner_username !== auth.username) {
            return jsonResponse({ success: false, error: '只有小组创建者可以审核' }, 403);
        }

        await ensureOwnerMembershipActive(db, groupId, auth.username);

        await db.prepare(`
      UPDATE meditation_group_members
      SET status = ?, joined_at = CASE WHEN ? = 'active' THEN ? ELSE joined_at END, updated_at = ?
      WHERE group_id = ? AND username = ? AND status = 'pending'
    `).bind(approve ? 'active' : 'rejected', approve ? 'active' : 'rejected', new Date().toISOString(), new Date().toISOString(), groupId, username).run();

        return jsonResponse({ success: true });
    } catch (e) {
        console.error('审核共修申请失败:', e);
        return jsonResponse({ success: false, error: '审核失败' }, 500);
    }
}

// 获取修行统计数据 GET /api/meditation/stats
export async function handleGetStats(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const today = new Date().toISOString().split('T')[0];

        // 今日统计
        const todayStats = await withUserScope(db, auth, (scope) => ({
            sql: `
      SELECT sutra_name, SUM(chant_count) as today_count, SUM(duration) as today_duration
      FROM meditation_records
      WHERE ${scope.where} AND record_date = ?
      GROUP BY sutra_name
      ORDER BY today_count DESC
      LIMIT 1
    `,
            params: [...scope.params, today]
        }), 'first');

        // 累计统计
        const totalStats = await withUserScope(db, auth, (scope) => ({
            sql: `
      SELECT 
        COUNT(*) as total_records,
        SUM(chant_count) as total_count,
        SUM(duration) as total_duration,
        COUNT(DISTINCT record_date) as total_days
      FROM meditation_records
      WHERE ${scope.where}
    `,
            params: [...scope.params]
        }), 'first');

        // 连续天数计算
        const consecutiveDays = await calculateConsecutiveDays(db, auth, today);

        // 按功课分类统计
        const sutraStats = await withUserScope(db, auth, (scope) => ({
            sql: `
      SELECT sutra_name, SUM(chant_count) as count, SUM(duration) as duration, COUNT(DISTINCT record_date) as days
      FROM meditation_records
      WHERE ${scope.where}
      GROUP BY sutra_name
      ORDER BY count DESC
    `,
            params: [...scope.params]
        }));

        return jsonResponse({
            success: true,
            data: {
                today: {
                    sutra: todayStats?.sutra_name || null,
                    count: todayStats?.today_count || 0,
                    duration: todayStats?.today_duration || 0
                },
                total: {
                    records: totalStats?.total_records || 0,
                    count: totalStats?.total_count || 0,
                    duration: totalStats?.total_duration || 0,
                    days: totalStats?.total_days || 0
                },
                consecutiveDays,
                bySubject: sutraStats.results || []
            }
        });
    } catch (e) {
        console.error('获取修行统计失败:', e);
        return jsonResponse({ success: false, error: '获取统计失败' }, 500);
    }
}

// 计算连续修行天数
async function calculateConsecutiveDays(db, auth, today) {
    try {
        const result = await withUserScope(db, auth, (scope) => ({
            sql: `
      SELECT DISTINCT record_date
      FROM meditation_records
      WHERE ${scope.where}
      ORDER BY record_date DESC
      LIMIT 365
    `,
            params: [...scope.params]
        }));

        if (!result.results || result.results.length === 0) {
            return 0;
        }

        const dates = result.results.map(r => r.record_date);
        let consecutive = 0;
        let checkDate = new Date(today);

        for (let i = 0; i < 365; i++) {
            const dateStr = checkDate.toISOString().split('T')[0];
            if (dates.includes(dateStr)) {
                consecutive++;
                checkDate.setDate(checkDate.getDate() - 1);
            } else if (i === 0) {
                // 今天还没修行，检查昨天开始
                checkDate.setDate(checkDate.getDate() - 1);
            } else {
                break;
            }
        }

        return consecutive;
    } catch (e) {
        console.error('计算连续天数失败:', e);
        return 0;
    }
}

// 获取周统计数据 GET /api/meditation/weekly
export async function handleGetWeeklyStats(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const today = new Date();
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 6);

        const result = await withUserScope(db, auth, (scope) => ({
            sql: `
      SELECT record_date, SUM(chant_count) as count, SUM(duration) as duration
      FROM meditation_records
      WHERE ${scope.where} AND record_date >= ? AND record_date <= ?
      GROUP BY record_date
      ORDER BY record_date ASC
    `,
            params: [
                ...scope.params,
                weekAgo.toISOString().split('T')[0],
                today.toISOString().split('T')[0]
            ]
        }));

        // 填充缺失的日期
        const weekData = [];
        for (let i = 0; i < 7; i++) {
            const date = new Date(weekAgo);
            date.setDate(date.getDate() + i);
            const dateStr = date.toISOString().split('T')[0];
            const dayData = result.results?.find(r => r.record_date === dateStr);
            weekData.push({
                date: dateStr,
                day: ['日', '一', '二', '三', '四', '五', '六'][date.getDay()],
                count: dayData?.count || 0,
                duration: dayData?.duration || 0
            });
        }

        const weekTotal = weekData.reduce((sum, d) => sum + d.count, 0);

        return jsonResponse({
            success: true,
            data: {
                days: weekData,
                weekTotal
            }
        });
    } catch (e) {
        console.error('获取周统计失败:', e);
        return jsonResponse({ success: false, error: '获取周统计失败' }, 500);
    }
}

// 获取月统计数据 GET /api/meditation/monthly
export async function handleGetMonthlyStats(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const today = new Date();
        const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

        const result = await withUserScope(db, auth, (scope) => ({
            sql: `
      SELECT record_date, SUM(chant_count) as count, SUM(duration) as duration
      FROM meditation_records
      WHERE ${scope.where} AND record_date >= ? AND record_date <= ?
      GROUP BY record_date
      ORDER BY record_date ASC
    `,
            params: [
                ...scope.params,
                monthStart.toISOString().split('T')[0],
                today.toISOString().split('T')[0]
            ]
        }));

        const monthTotal = result.results?.reduce((sum, d) => sum + d.count, 0) || 0;

        return jsonResponse({
            success: true,
            data: {
                days: result.results || [],
                monthTotal
            }
        });
    } catch (e) {
        console.error('获取月统计失败:', e);
        return jsonResponse({ success: false, error: '获取月统计失败' }, 500);
    }
}

// 设置发愿目标 POST /api/meditation/goal
export async function handleSetGoal(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const body = await request.json();
        const { sutra, targetCount, dedication = '' } = body;

        if (!sutra || !targetCount) {
            return jsonResponse({ success: false, error: '功课名称和目标数量不能为空' }, 400);
        }

        const now = new Date().toISOString();

        // 检查是否已有同功课的活跃目标
        const existing = await withUserScope(db, auth, (scope) => ({
            sql: `
      SELECT id, current_count FROM meditation_goals
      WHERE ${scope.where} AND sutra_name = ? AND status = 'active'
    `,
            params: [...scope.params, sutra]
        }), 'first');

        if (existing) {
            // 更新现有目标
            await db.prepare(`
        UPDATE meditation_goals
        SET target_count = ?, dedication = ?, updated_at = ?
        WHERE id = ?
      `).bind(targetCount, dedication, now, existing.id).run();
        } else {
            // 创建新目标
            const insertWithoutUserId = () => db.prepare(`
        INSERT INTO meditation_goals (username, sutra_name, target_count, dedication, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(auth.username, sutra, targetCount, dedication, now, now).run();

            if (hasStableUserId(auth)) {
                try {
                    await db.prepare(`
        INSERT INTO meditation_goals (username, user_id, sutra_name, target_count, dedication, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(auth.username, auth.userId, sutra, targetCount, dedication, now, now).run();
                } catch (error) {
                    if (!isMissingUserIdColumnError(error)) throw error;
                    await insertWithoutUserId();
                }
            } else {
                await insertWithoutUserId();
            }
        }

        return jsonResponse({ success: true, message: '发愿目标已设置' });
    } catch (e) {
        console.error('设置发愿目标失败:', e);
        return jsonResponse({ success: false, error: '设置目标失败' }, 500);
    }
}

// 获取发愿目标 GET /api/meditation/goal
export async function handleGetGoals(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const url = new URL(request.url);
        const status = url.searchParams.get('status') || 'active';

        const result = await withUserScope(db, auth, (scope) => ({
            sql: `
      SELECT id, sutra_name, target_count, current_count, dedication, status, created_at, completed_at
      FROM meditation_goals
      WHERE ${scope.where} AND status = ?
      ORDER BY created_at DESC
    `,
            params: [...scope.params, status]
        }));

        const goals = (result.results || []).map(goal => ({
            ...goal,
            progress: goal.target_count > 0 ? Math.round((goal.current_count / goal.target_count) * 100) : 0
        }));

        return jsonResponse({
            success: true,
            data: { goals }
        });
    } catch (e) {
        console.error('获取发愿目标失败:', e);
        return jsonResponse({ success: false, error: '获取目标失败' }, 500);
    }
}

// 获取/更新修行设置 
export async function handleMeditationSettings(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    if (request.method === 'GET') {
        try {
            const settings = await withUserScope(db, auth, (scope) => ({
                sql: `
        SELECT default_sutra, default_duration, reminder_enabled, reminder_time
        FROM meditation_settings
        WHERE ${scope.where}
      `,
                params: [...scope.params]
            }), 'first');

            return jsonResponse({
                success: true,
                data: settings || {
                    default_sutra: null,
                    default_duration: 30,
                    reminder_enabled: 0,
                    reminder_time: null
                }
            });
        } catch (e) {
            return jsonResponse({ success: false, error: '获取设置失败' }, 500);
        }
    }

    if (request.method === 'POST') {
        try {
            const body = await request.json();
            const { defaultSutra, defaultDuration = 30, reminderEnabled = false, reminderTime } = body;
            const now = new Date().toISOString();

            // Upsert设置
            const existing = await withUserScope(db, auth, (scope) => ({
                sql: `
        SELECT id
        FROM meditation_settings
        WHERE ${scope.where}
        LIMIT 1
      `,
                params: [...scope.params]
            }), 'first');

            if (existing?.id) {
                await db.prepare(`
        UPDATE meditation_settings
        SET username = ?,
            default_sutra = ?,
            default_duration = ?,
            reminder_enabled = ?,
            reminder_time = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(auth.username, defaultSutra, defaultDuration, reminderEnabled ? 1 : 0, reminderTime, now, existing.id).run();
            } else {
                const insertWithoutUserId = () => db.prepare(`
        INSERT INTO meditation_settings (username, default_sutra, default_duration, reminder_enabled, reminder_time, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(auth.username, defaultSutra, defaultDuration, reminderEnabled ? 1 : 0, reminderTime, now, now).run();

                if (hasStableUserId(auth)) {
                    try {
                        await db.prepare(`
        INSERT INTO meditation_settings (username, user_id, default_sutra, default_duration, reminder_enabled, reminder_time, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(auth.username, auth.userId, defaultSutra, defaultDuration, reminderEnabled ? 1 : 0, reminderTime, now, now).run();
                    } catch (error) {
                        if (!isMissingUserIdColumnError(error)) throw error;
                        await insertWithoutUserId();
                    }
                } else {
                    await insertWithoutUserId();
                }
            }

            return jsonResponse({ success: true, message: '设置已保存' });
        } catch (e) {
            return jsonResponse({ success: false, error: '保存设置失败' }, 500);
        }
    }

    return jsonResponse({ success: false, error: '不支持的请求方法' }, 405);
}
