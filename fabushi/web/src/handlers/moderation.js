// 内容举报和用户屏蔽 API 处理器
// 满足 App Store Guideline 1.2 要求

import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { isAdminUser } from '../utils/helpers.js';

async function authenticatedUser(request, env, db) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = await verifyToken(auth.slice(7), env);
  if (!token) return null;
  if (token.userId !== undefined && token.userId !== null && db.getUserById) {
    const user = await db.getUserById(token.userId);
    if (user) return user;
  }
  if (token.username) return await db.getUser(token.username);
  return null;
}

async function requireUser(request, env, db) {
  const user = await authenticatedUser(request, env, db);
  return user || jsonResponse({ error: '认证失败' }, 401);
}

async function requireAdmin(request, env, db) {
  const user = await authenticatedUser(request, env, db);
  if (!user) return { response: jsonResponse({ error: '认证失败' }, 401) };
  if (!isAdminUser(user, env)) return { response: jsonResponse({ error: '权限不足' }, 403) };
  return { user };
}

async function ensureModerationTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS content_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      description TEXT DEFAULT '',
      reporter_user_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewer_note TEXT
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS user_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blocker_user_id TEXT,
      blocked_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    )
  `).run();
  try {
    await db.prepare('ALTER TABLE user_blocks ADD COLUMN blocker_user_id TEXT').run();
  } catch {
    // Existing schema already has the column, or the database has applied the migration.
  }
}

export async function handleReport(request, env, db) {
  try {
    const actor = await requireUser(request, env, db);
    if (actor instanceof Response) return actor;
    const { content_id, reason, description } = await request.json();
    if (!content_id || !reason) return jsonResponse({ error: '缺少必要参数' }, 400);
    if (String(content_id).length > 256 || String(reason).length > 120 || String(description || '').length > 2000) {
      return jsonResponse({ error: '举报内容超出长度限制' }, 400);
    }

    await ensureModerationTables(db);
    await db.prepare(`
      INSERT INTO content_reports (content_id, reason, description, reporter_user_id, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).bind(
      String(content_id),
      String(reason),
      String(description || ''),
      String(actor.id ?? actor.username),
      new Date().toISOString()
    ).run();

    return jsonResponse({ success: true, message: '举报已提交' }, 201);
  } catch (error) {
    console.error('举报处理失败:', error?.message || error);
    return jsonResponse({ error: '举报处理失败' }, 500);
  }
}

export async function handleBlockUser(request, env, db) {
  try {
    const actor = await requireUser(request, env, db);
    if (actor instanceof Response) return actor;
    const { blocked_user_id, action, reason } = await request.json();
    if (!blocked_user_id || !['block', 'unblock'].includes(action)) return jsonResponse({ error: '参数无效' }, 400);
    if (String(blocked_user_id) === String(actor.id) || String(blocked_user_id) === String(actor.username)) {
      return jsonResponse({ error: '不能屏蔽自己' }, 400);
    }
    if (String(reason || '').length > 1000) return jsonResponse({ error: '原因超出长度限制' }, 400);

    await ensureModerationTables(db);
    await db.prepare(`
      INSERT INTO user_blocks (blocker_user_id, blocked_user_id, action, reason, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).bind(
      String(actor.id ?? actor.username),
      String(blocked_user_id),
      action,
      String(reason || ''),
      new Date().toISOString()
    ).run();

    return jsonResponse({ success: true, message: `用户${action === 'block' ? '已屏蔽' : '已取消屏蔽'}` }, 201);
  } catch (error) {
    console.error('屏蔽处理失败:', error?.message || error);
    return jsonResponse({ error: '屏蔽处理失败' }, 500);
  }
}

export async function handleGetReports(request, env, db) {
  try {
    const admin = await requireAdmin(request, env, db);
    if (admin.response) return admin.response;
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'pending';
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('pageSize') || '20', 10) || 20));
    const offset = (page - 1) * pageSize;
    await ensureModerationTables(db);
    const result = await db.prepare(`SELECT * FROM content_reports WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(status, pageSize, offset).all();
    const countResult = await db.prepare('SELECT COUNT(*) as total FROM content_reports WHERE status = ?').bind(status).first();
    return jsonResponse({ reports: result.results || [], total: countResult?.total || 0, page, pageSize });
  } catch (error) {
    console.error('获取举报列表失败:', error?.message || error);
    return jsonResponse({ error: '获取举报列表失败' }, 500);
  }
}

export async function handleReviewReport(request, env, db) {
  try {
    const admin = await requireAdmin(request, env, db);
    if (admin.response) return admin.response;
    const { report_id, action, reviewer_note } = await request.json();
    const allowedActions = new Set(['resolved', 'dismissed', 'user_ejected']);
    if (!report_id || !allowedActions.has(action)) return jsonResponse({ error: '参数无效' }, 400);
    if (String(reviewer_note || '').length > 2000) return jsonResponse({ error: '审核备注超出长度限制' }, 400);
    const result = await db.prepare(`UPDATE content_reports SET status = ?, reviewed_at = ?, reviewer_note = ? WHERE id = ?`)
      .bind(action, new Date().toISOString(), String(reviewer_note || ''), report_id).run();
    if (result?.meta?.changes === 0) return jsonResponse({ error: '举报不存在' }, 404);
    return jsonResponse({ success: true, message: '审核完成' });
  } catch (error) {
    console.error('审核举报失败:', error?.message || error);
    return jsonResponse({ error: '审核举报失败' }, 500);
  }
}

export async function handleGetBlocks(request, env, db) {
  try {
    const admin = await requireAdmin(request, env, db);
    if (admin.response) return admin.response;
    const url = new URL(request.url);
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('pageSize') || '20', 10) || 20));
    const offset = (page - 1) * pageSize;
    await ensureModerationTables(db);
    const result = await db.prepare(`SELECT * FROM user_blocks ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(pageSize, offset).all();
    const countResult = await db.prepare('SELECT COUNT(*) as total FROM user_blocks').first();
    return jsonResponse({ blocks: result.results || [], total: countResult?.total || 0, page, pageSize });
  } catch (error) {
    console.error('获取屏蔽记录失败:', error?.message || error);
    return jsonResponse({ error: '获取屏蔽记录失败' }, 500);
  }
}
