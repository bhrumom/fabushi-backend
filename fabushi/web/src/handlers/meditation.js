import { jsonResponse } from '../utils/response.js';

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

        return { username };
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

async function refreshGroupsForUser(db, username) {
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
      SELECT id, daily_goal_minutes, cumulative_miss_limit, consecutive_miss_limit
      FROM meditation_groups
      WHERE id = ?
    `).bind(groupId).first();

    if (!group || !group.daily_goal_minutes || group.daily_goal_minutes <= 0) {
        return;
    }

    const today = formatDate(new Date());
    const yesterday = formatDate(addDays(new Date(), -1));
    let memberQuery = `
      SELECT id, username, joined_at
      FROM meditation_group_members
      WHERE group_id = ? AND status = 'active'
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
        totalDuration: row.total_duration || row.totalDuration || 0,
        todayDuration: row.today_duration || row.todayDuration || 0,
        myStatus: row.my_status || null,
        myRole: row.my_role || null,
        myWarningMessage: row.my_warning_message || null,
        createdAt: row.created_at || null
    };
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
    `).bind(auth.username, auth.username, auth.username, auth.username, auth.username).first();
        const nextVersion = versionResult?.next_version || 1;

        const insertResult = await db.prepare(`
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
            duration,
            chantCount,
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

        // 更新发愿目标进度
        await db.prepare(`
      UPDATE meditation_goals
      SET current_count = current_count + ?,
          updated_at = ?,
          sync_version = ?
      WHERE username = ? AND sutra_name = ? AND status = 'active'
    `).bind(chantCount, now, nextVersion + 1, auth.username, sutra).run();

        await Promise.allSettled([
            env.USERS_KV?.delete('leaderboard:cache'),
            env.USERS_KV?.delete('leaderboard:practice:v2'),
            env.USERS_KV?.delete('leaderboard:practice:v3')
        ]);

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

        let query = `
      SELECT id, sutra_name, sutra_source, duration, chant_count, record_date,
             local_time, timezone_offset_minutes, start_time, end_time,
             is_manual, notes, created_at
      FROM meditation_records
      WHERE username = ?
    `;
        const params = [auth.username];

        if (sutra) {
            query += ` AND sutra_name = ?`;
            params.push(sutra);
        }

        let countQuery = `
      SELECT COUNT(*) as total
      FROM meditation_records
      WHERE username = ?
    `;
        const countParams = [auth.username];
        if (sutra) {
            countQuery += ` AND sutra_name = ?`;
            countParams.push(sutra);
        }

        query += ` ORDER BY record_date DESC, created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [result, totalResult] = await Promise.all([
            db.prepare(query).bind(...params).all(),
            db.prepare(countQuery).bind(...countParams).first()
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

// 搜索/查看共修小组 GET /api/meditation/groups
export async function handleGetMeditationGroups(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        await refreshGroupsForUser(db, auth.username);

        const url = new URL(request.url);
        const query = (url.searchParams.get('query') || '').trim();
        const requestedLimit = parseInt(url.searchParams.get('limit') || '30');
        const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 30;
        const today = formatDate(new Date());
        const params = [today, auth.username];
        let whereClause = '';

        if (query) {
            whereClause = `WHERE g.name LIKE ? OR g.description LIKE ?`;
            params.push(`%${query}%`, `%${query}%`);
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

        const pendingResult = groupRow.my_role === 'owner'
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

        const owner = await db.prepare(`
      SELECT role
      FROM meditation_group_members
      WHERE group_id = ? AND username = ? AND status = 'active'
    `).bind(groupId, auth.username).first();
        if (!owner || owner.role !== 'owner') {
            return jsonResponse({ success: false, error: '只有小组创建者可以审核' }, 403);
        }

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
        const todayStats = await db.prepare(`
      SELECT sutra_name, SUM(chant_count) as today_count, SUM(duration) as today_duration
      FROM meditation_records
      WHERE username = ? AND record_date = ?
      GROUP BY sutra_name
      ORDER BY today_count DESC
      LIMIT 1
    `).bind(auth.username, today).first();

        // 累计统计
        const totalStats = await db.prepare(`
      SELECT 
        COUNT(*) as total_records,
        SUM(chant_count) as total_count,
        SUM(duration) as total_duration,
        COUNT(DISTINCT record_date) as total_days
      FROM meditation_records
      WHERE username = ?
    `).bind(auth.username).first();

        // 连续天数计算
        const consecutiveDays = await calculateConsecutiveDays(db, auth.username, today);

        // 按功课分类统计
        const sutraStats = await db.prepare(`
      SELECT sutra_name, SUM(chant_count) as count, SUM(duration) as duration, COUNT(DISTINCT record_date) as days
      FROM meditation_records
      WHERE username = ?
      GROUP BY sutra_name
      ORDER BY count DESC
    `).bind(auth.username).all();

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
async function calculateConsecutiveDays(db, username, today) {
    try {
        const result = await db.prepare(`
      SELECT DISTINCT record_date
      FROM meditation_records
      WHERE username = ?
      ORDER BY record_date DESC
      LIMIT 365
    `).bind(username).all();

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

        const result = await db.prepare(`
      SELECT record_date, SUM(chant_count) as count, SUM(duration) as duration
      FROM meditation_records
      WHERE username = ? AND record_date >= ? AND record_date <= ?
      GROUP BY record_date
      ORDER BY record_date ASC
    `).bind(auth.username, weekAgo.toISOString().split('T')[0], today.toISOString().split('T')[0]).all();

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

        const result = await db.prepare(`
      SELECT record_date, SUM(chant_count) as count, SUM(duration) as duration
      FROM meditation_records
      WHERE username = ? AND record_date >= ? AND record_date <= ?
      GROUP BY record_date
      ORDER BY record_date ASC
    `).bind(auth.username, monthStart.toISOString().split('T')[0], today.toISOString().split('T')[0]).all();

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
        const existing = await db.prepare(`
      SELECT id, current_count FROM meditation_goals
      WHERE username = ? AND sutra_name = ? AND status = 'active'
    `).bind(auth.username, sutra).first();

        if (existing) {
            // 更新现有目标
            await db.prepare(`
        UPDATE meditation_goals
        SET target_count = ?, dedication = ?, updated_at = ?
        WHERE id = ?
      `).bind(targetCount, dedication, now, existing.id).run();
        } else {
            // 创建新目标
            await db.prepare(`
        INSERT INTO meditation_goals (username, sutra_name, target_count, dedication, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(auth.username, sutra, targetCount, dedication, now, now).run();
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

        const result = await db.prepare(`
      SELECT id, sutra_name, target_count, current_count, dedication, status, created_at, completed_at
      FROM meditation_goals
      WHERE username = ? AND status = ?
      ORDER BY created_at DESC
    `).bind(auth.username, status).all();

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
            const settings = await db.prepare(`
        SELECT default_sutra, default_duration, reminder_enabled, reminder_time
        FROM meditation_settings
        WHERE username = ?
      `).bind(auth.username).first();

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
            await db.prepare(`
        INSERT INTO meditation_settings (username, default_sutra, default_duration, reminder_enabled, reminder_time, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
          default_sutra = excluded.default_sutra,
          default_duration = excluded.default_duration,
          reminder_enabled = excluded.reminder_enabled,
          reminder_time = excluded.reminder_time,
          updated_at = excluded.updated_at
      `).bind(auth.username, defaultSutra, defaultDuration, reminderEnabled ? 1 : 0, reminderTime, now, now).run();

            return jsonResponse({ success: true, message: '设置已保存' });
        } catch (e) {
            return jsonResponse({ success: false, error: '保存设置失败' }, 500);
        }
    }

    return jsonResponse({ success: false, error: '不支持的请求方法' }, 405);
}
