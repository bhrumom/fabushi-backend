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

// 同步修行记录 POST /api/meditation/record
export async function handleSyncRecord(request, env, db) {
    const auth = await authenticateUser(request, db);
    if (auth.error) {
        return jsonResponse({ success: false, error: auth.error }, auth.status);
    }

    try {
        const body = await request.json();
        const { sutra, sutraSource = 'custom', duration = 0, chantCount = 0, notes = '', isManual = false, recordDate } = body;

        if (!sutra) {
            return jsonResponse({ success: false, error: '功课名称不能为空' }, 400);
        }

        const now = new Date().toISOString();
        const date = recordDate || now.split('T')[0];
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
      INSERT INTO meditation_records (username, sutra_name, sutra_source, duration, chant_count, record_date, is_manual, notes, created_at, sync_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(auth.username, sutra, sutraSource, duration, chantCount, date, isManual ? 1 : 0, notes, now, nextVersion).run();

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
            env.USERS_KV?.delete('leaderboard:practice:v2')
        ]);

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
      SELECT id, sutra_name, sutra_source, duration, chant_count, record_date, is_manual, notes, created_at
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
