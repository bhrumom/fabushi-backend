// 内容举报和用户屏蔽 API 处理器
// 满足 App Store Guideline 1.2 要求

import { jsonResponse } from '../utils/response.js';

/**
 * POST /api/report
 * 提交内容举报
 */
export async function handleReport(request, env, db) {
  try {
    const body = await request.json();
    const { content_id, reason, description, reporter_user_id, timestamp } = body;

    if (!content_id || !reason) {
      return jsonResponse({ error: '缺少必要参数' }, 400);
    }

    // 建表（如果不存在）
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS content_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        description TEXT DEFAULT '',
        reporter_user_id TEXT DEFAULT 'anonymous',
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewer_note TEXT
      )
    `).run();

    // 插入举报记录
    await db.prepare(`
      INSERT INTO content_reports (content_id, reason, description, reporter_user_id, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).bind(
      content_id,
      reason,
      description || '',
      reporter_user_id || 'anonymous',
      timestamp || new Date().toISOString()
    ).run();

    console.log(`📢 新举报: content_id=${content_id}, reason=${reason}, reporter=${reporter_user_id}`);

    return jsonResponse({ success: true, message: '举报已提交' }, 201);
  } catch (error) {
    console.error('举报处理失败:', error);
    return jsonResponse({ error: '举报处理失败' }, 500);
  }
}

/**
 * POST /api/block-user
 * 屏蔽用户（同时记录到后端供管理员审核）
 */
export async function handleBlockUser(request, env, db) {
  try {
    const body = await request.json();
    const { blocked_user_id, action, reason, timestamp } = body;

    if (!blocked_user_id || !action) {
      return jsonResponse({ error: '缺少必要参数' }, 400);
    }

    // 建表（如果不存在）
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS user_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        blocked_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      )
    `).run();

    // 插入屏蔽记录
    await db.prepare(`
      INSERT INTO user_blocks (blocked_user_id, action, reason, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).bind(
      blocked_user_id,
      action,
      reason || '',
      timestamp || new Date().toISOString()
    ).run();

    console.log(`🚫 用户屏蔽: blocked_user_id=${blocked_user_id}, action=${action}`);

    return jsonResponse({ success: true, message: `用户${action === 'block' ? '已屏蔽' : '已取消屏蔽'}` }, 201);
  } catch (error) {
    console.error('屏蔽处理失败:', error);
    return jsonResponse({ error: '屏蔽处理失败' }, 500);
  }
}

/**
 * GET /api/admin/reports
 * 管理员查看举报列表（审核用）
 */
export async function handleGetReports(request, env, db) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'pending';
    const page = parseInt(url.searchParams.get('page') || '1');
    const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
    const offset = (page - 1) * pageSize;

    // 确保表存在
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS content_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        description TEXT DEFAULT '',
        reporter_user_id TEXT DEFAULT 'anonymous',
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewer_note TEXT
      )
    `).run();

    const result = await db.prepare(`
      SELECT * FROM content_reports 
      WHERE status = ? 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `).bind(status, pageSize, offset).all();

    const countResult = await db.prepare(
      'SELECT COUNT(*) as total FROM content_reports WHERE status = ?'
    ).bind(status).first();

    return jsonResponse({
      reports: result.results || [],
      total: countResult?.total || 0,
      page,
      pageSize,
    });
  } catch (error) {
    console.error('获取举报列表失败:', error);
    return jsonResponse({ error: '获取举报列表失败' }, 500);
  }
}

/**
 * POST /api/admin/reports/review
 * 管理员审核举报
 */
export async function handleReviewReport(request, env, db) {
  try {
    const body = await request.json();
    const { report_id, action, reviewer_note } = body;
    // action: 'resolved' | 'dismissed' | 'user_ejected'

    if (!report_id || !action) {
      return jsonResponse({ error: '缺少必要参数' }, 400);
    }

    await db.prepare(`
      UPDATE content_reports 
      SET status = ?, reviewed_at = ?, reviewer_note = ? 
      WHERE id = ?
    `).bind(
      action,
      new Date().toISOString(),
      reviewer_note || '',
      report_id
    ).run();

    return jsonResponse({ success: true, message: '审核完成' });
  } catch (error) {
    console.error('审核举报失败:', error);
    return jsonResponse({ error: '审核举报失败' }, 500);
  }
}

/**
 * GET /api/admin/blocks
 * 管理员查看屏蔽记录
 */
export async function handleGetBlocks(request, env, db) {
  try {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
    const offset = (page - 1) * pageSize;

    // 确保表存在
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS user_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        blocked_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      )
    `).run();

    const result = await db.prepare(`
      SELECT * FROM user_blocks 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `).bind(pageSize, offset).all();

    const countResult = await db.prepare(
      'SELECT COUNT(*) as total FROM user_blocks'
    ).first();

    return jsonResponse({
      blocks: result.results || [],
      total: countResult?.total || 0,
      page,
      pageSize,
    });
  } catch (error) {
    console.error('获取屏蔽记录失败:', error);
    return jsonResponse({ error: '获取屏蔽记录失败' }, 500);
  }
}
