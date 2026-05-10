import {
  handleGetRecords,
  handleUpdateRecord,
  handleDeleteRecord,
  handleGetStats,
  handleGetWeeklyStats,
  handleGetMonthlyStats,
  handleSetGoal,
  handleGetGoals,
  handleMeditationSettings,
  handleGetMeditationGroups,
  handleCreateMeditationGroup,
  handleJoinMeditationGroup,
  handleGetMeditationGroupDetail,
  handleReviewMeditationGroupJoin,
  handleSyncRecord,
} from '../handlers/meditation.js';
import { generateSnowflakeUserId as generateSnowflakeGroupId } from '../services/database.js';
import {
  GROUP_NO_MAX_LENGTH,
  GROUP_NO_MIN_LENGTH,
  generateGroupNo,
} from '../services/external-numbers.js';
import { jsonResponse } from '../utils/response.js';

function asInt(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function resolveUserIdByUsername(db, username) {
  if (!username) return null;
  try {
    const row = await db.prepare(`
      SELECT id
      FROM users
      WHERE username = ?
    `).bind(username).first();
    return row?.id ?? null;
  } catch (_) {
    return null;
  }
}

async function authenticateRouteUser(request, db = null) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: '未授权访问', status: 401 };
  }

  const token = authHeader.substring(7);
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { error: 'Token格式无效', status: 401 };
    }

    const payload = JSON.parse(atob(parts[1]));
    const username = payload.username || payload.sub;
    if (!username) {
      return { error: '无法获取用户信息', status: 401 };
    }

    const tokenUserId = payload.userId ?? payload.id ?? null;
    const userId = tokenUserId ?? (db ? await resolveUserIdByUsername(db, username) : null);
    return { username, userId };
  } catch (_) {
    return { error: 'Token解析失败', status: 401 };
  }
}

function isMissingUserIdColumnError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('owner_user_id') ||
    message.includes('user_id') ||
    message.includes('no such column') ||
    message.includes('has no column named');
}

async function resolveGroupById(db, groupId) {
  const normalizedGroupId = asInt(groupId);
  if (!normalizedGroupId) return null;
  return await db.prepare(`
    SELECT id
    FROM meditation_groups
    WHERE id = ?
  `).bind(normalizedGroupId).first();
}

async function resolveGroupIdFromGroupNo(db, groupNo) {
  const normalizedGroupNo = asInt(groupNo);
  if (!normalizedGroupNo) return null;
  const result = await db.prepare(`
    SELECT id
    FROM meditation_groups
    WHERE group_no = ?
  `).bind(normalizedGroupNo).first();
  return result?.id || null;
}

async function getGroupNoById(db, groupId) {
  const normalizedGroupId = asInt(groupId);
  if (!normalizedGroupId) return null;
  const result = await db.prepare(`
    SELECT group_no
    FROM meditation_groups
    WHERE id = ?
  `).bind(normalizedGroupId).first();
  return result?.group_no || null;
}

async function generateUniqueGroupId(db) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = generateSnowflakeGroupId();
    const existingGroup = await resolveGroupById(db, candidate);
    if (!existingGroup) return candidate;
  }

  throw new Error('无法生成可用的雪花式小组 ID');
}

async function generateUniqueGroupNo(db) {
  for (let length = GROUP_NO_MIN_LENGTH; length <= GROUP_NO_MAX_LENGTH; length += 1) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const candidate = generateGroupNo(length);
      const existingGroupId = await resolveGroupIdFromGroupNo(db, candidate);
      if (!existingGroupId) return candidate;
    }
  }

  throw new Error(`无法生成可用的 ${GROUP_NO_MIN_LENGTH}-${GROUP_NO_MAX_LENGTH} 位群号`);
}

async function ensureCreatedGroupNo(db, groupId) {
  const normalizedGroupId = asInt(groupId);
  if (!normalizedGroupId) return null;

  const currentGroupNo = await getGroupNoById(db, normalizedGroupId);
  if (currentGroupNo && currentGroupNo !== normalizedGroupId) {
    return currentGroupNo;
  }

  const groupNo = await generateUniqueGroupNo(db);
  await db.prepare(`
    UPDATE meditation_groups
    SET group_no = ?,
        updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
    WHERE id = ?
  `).bind(groupNo, normalizedGroupId).run();

  return groupNo;
}

async function cloneRequestWithJsonBody(request, body) {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
}

function cloneRequestWithUrl(request, nextUrl) {
  return new Request(nextUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
  });
}

async function rewriteNumericGroupQueryToInternalId(request, db) {
  const url = new URL(request.url);
  const rawQuery = (url.searchParams.get('query') || '').trim();
  const normalized = rawQuery.startsWith('#') ? rawQuery.slice(1).trim() : rawQuery;
  if (!/^\d+$/.test(normalized)) {
    return request;
  }

  const groupId = await resolveGroupIdFromGroupNo(db, normalized);
  if (!groupId) {
    return request;
  }

  url.searchParams.set('query', `#${groupId}`);
  return cloneRequestWithUrl(request, url);
}

async function rewriteGroupDetailRequest(request, db) {
  const url = new URL(request.url);
  const groupNo = url.searchParams.get('groupNo');
  if (!groupNo || url.searchParams.get('groupId')) {
    return request;
  }

  const groupId = await resolveGroupIdFromGroupNo(db, groupNo);
  if (!groupId) {
    return request;
  }

  url.searchParams.set('groupId', String(groupId));
  return cloneRequestWithUrl(request, url);
}

async function rewriteGroupBodyRequest(request, db) {
  const body = await request.json();
  let nextBody = body;

  if (!body.groupId && body.groupNo) {
    const groupId = await resolveGroupIdFromGroupNo(db, body.groupNo);
    if (groupId) {
      nextBody = {
        ...body,
        groupId,
      };
    }
  }

  return {
    request: await cloneRequestWithJsonBody(request, nextBody),
    body: nextBody,
  };
}

async function withVisibleGroupNumbers(response, db, options = {}) {
  const payload = await response.json();
  const nextPayload = structuredClone(payload);

  const groups = nextPayload?.data?.groups;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      const groupNo = await getGroupNoById(db, group.id);
      if (groupNo) {
        group.groupNo = groupNo;
      }
    }
  }

  const group = nextPayload?.data?.group;
  if (group?.id) {
    const groupNo = await getGroupNoById(db, group.id);
    if (groupNo) {
      group.groupNo = groupNo;
    }
  }

  if (options.includeCreatedGroupNo && nextPayload?.data?.groupId) {
    const groupNo = options.assignCreatedGroupNo
      ? await ensureCreatedGroupNo(db, nextPayload.data.groupId)
      : await getGroupNoById(db, nextPayload.data.groupId);
    if (groupNo) {
      nextPayload.data.groupNo = groupNo;
    }
  }

  return jsonResponse(nextPayload, response.status);
}

async function handleCreateMeditationGroupWithGeneratedIds(request, db) {
  const auth = await authenticateRouteUser(request, db);
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
    const groupId = await generateUniqueGroupId(db);
    const groupNo = await generateUniqueGroupNo(db);
    const dailyGoalMinutes = Math.max(0, asInt(body.dailyGoalMinutes, 30));
    const cumulativeMissLimit = Math.max(0, asInt(body.cumulativeMissLimit, 7));
    const consecutiveMissLimit = Math.max(0, asInt(body.consecutiveMissLimit, 3));

    try {
      await db.prepare(`
        INSERT INTO meditation_groups (
          id, group_no, name, description, owner_username, owner_user_id, require_approval, daily_goal_minutes,
          cumulative_miss_limit, consecutive_miss_limit, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        groupId,
        groupNo,
        name,
        (body.description || '').toString().trim(),
        auth.username,
        auth.userId,
        body.requireApproval ? 1 : 0,
        dailyGoalMinutes,
        cumulativeMissLimit,
        consecutiveMissLimit,
        now,
        now
      ).run();

      await db.prepare(`
        INSERT INTO meditation_group_members (group_id, username, user_id, role, status, joined_at, updated_at)
        VALUES (?, ?, ?, 'owner', 'active', ?, ?)
      `).bind(groupId, auth.username, auth.userId, now, now).run();
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) {
        throw error;
      }

      await db.prepare(`
        INSERT INTO meditation_groups (
          id, group_no, name, description, owner_username, require_approval, daily_goal_minutes,
          cumulative_miss_limit, consecutive_miss_limit, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        groupId,
        groupNo,
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

      await db.prepare(`
        INSERT INTO meditation_group_members (group_id, username, role, status, joined_at, updated_at)
        VALUES (?, ?, 'owner', 'active', ?, ?)
      `).bind(groupId, auth.username, now, now).run();
    }

    return jsonResponse({ success: true, data: { groupId, groupNo } });
  } catch (e) {
    console.error('创建共修小组失败', e);
    return jsonResponse({ success: false, error: '创建共修小组失败' }, 500);
  }
}

async function handleJoinMeditationGroupWithStableUserId(request, env, db) {
  const auth = await authenticateRouteUser(request, db);
  if (auth.error) {
    return jsonResponse({ success: false, error: auth.error }, auth.status);
  }

  try {
    const body = await request.json();
    const groupId = asInt(body.groupId);
    if (!groupId) {
      return jsonResponse({ success: false, error: 'groupId required' }, 400);
    }

    if (!auth.userId) {
      return await handleJoinMeditationGroup(await cloneRequestWithJsonBody(request, body), env, db);
    }

    let group;
    try {
      group = await db.prepare(`
        SELECT id, require_approval, owner_username, owner_user_id
        FROM meditation_groups
        WHERE id = ?
      `).bind(groupId).first();
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) {
        throw error;
      }
      return await handleJoinMeditationGroup(await cloneRequestWithJsonBody(request, body), env, db);
    }

    if (!group) {
      return jsonResponse({ success: false, error: '小组不存在' }, 404);
    }

    const now = new Date().toISOString();
    const isOwner = group.owner_user_id === auth.userId || group.owner_username === auth.username;
    const role = isOwner ? 'owner' : 'member';
    const status = role === 'owner' || group.require_approval !== 1 ? 'active' : 'pending';

    const existing = await db.prepare(`
      SELECT id, role
      FROM meditation_group_members
      WHERE group_id = ? AND user_id = ?
    `).bind(groupId, auth.userId).first();

    if (existing) {
      await db.prepare(`
        UPDATE meditation_group_members
        SET username = ?,
            status = ?,
            role = CASE WHEN role = 'owner' THEN 'owner' ELSE ? END,
            warning_message = NULL,
            removal_reason = NULL,
            removed_at = NULL,
            updated_at = ?
        WHERE id = ?
      `).bind(auth.username, status, role, now, existing.id).run();
    } else {
      await db.prepare(`
        INSERT INTO meditation_group_members (group_id, username, user_id, role, status, joined_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(groupId, auth.username, auth.userId, role, status, now, now).run();
    }

    return jsonResponse({
      success: true,
      data: {
        status,
        message: status === 'pending' ? '已提交加入申请，等待同意' : '已加入共修小组',
      },
    });
  } catch (e) {
    if (isMissingUserIdColumnError(e)) {
      return await handleJoinMeditationGroup(request, env, db);
    }
    console.error('加入共修小组失败:', e);
    return jsonResponse({ success: false, error: '加入共修小组失败' }, 500);
  }
}

export async function routeMeditationRequest({ pathname, method, request, env, db }) {
  if (pathname === '/api/meditation/record' && method === 'POST') {
    return await handleSyncRecord(request, env, db);
  }
  if (pathname === '/api/meditation/records' && method === 'GET') {
    return await handleGetRecords(request, env, db);
  }
  if (pathname === '/api/meditation/records' && method === 'PUT') {
    return await handleUpdateRecord(request, env, db);
  }
  if (pathname === '/api/meditation/records' && method === 'DELETE') {
    return await handleDeleteRecord(request, env, db);
  }
  if (pathname === '/api/meditation/stats' && method === 'GET') {
    return await handleGetStats(request, env, db);
  }
  if (pathname === '/api/meditation/weekly' && method === 'GET') {
    return await handleGetWeeklyStats(request, env, db);
  }
  if (pathname === '/api/meditation/monthly' && method === 'GET') {
    return await handleGetMonthlyStats(request, env, db);
  }
  if (pathname === '/api/meditation/goal' && method === 'POST') {
    return await handleSetGoal(request, env, db);
  }
  if (pathname === '/api/meditation/goal' && method === 'GET') {
    return await handleGetGoals(request, env, db);
  }
  if (pathname === '/api/meditation/settings' && (method === 'GET' || method === 'POST')) {
    return await handleMeditationSettings(request, env, db);
  }
  if (pathname === '/api/meditation/groups' && method === 'GET') {
    const nextRequest = await rewriteNumericGroupQueryToInternalId(request, db);
    const response = await handleGetMeditationGroups(nextRequest, env, db);
    return await withVisibleGroupNumbers(response, db);
  }
  if (pathname === '/api/meditation/groups' && method === 'POST') {
    return await handleCreateMeditationGroupWithGeneratedIds(request, db);
  }
  if (pathname === '/api/meditation/groups/join' && method === 'POST') {
    const { request: nextRequest } = await rewriteGroupBodyRequest(request, db);
    return await handleJoinMeditationGroupWithStableUserId(nextRequest, env, db);
  }
  if (pathname === '/api/meditation/groups/detail' && method === 'GET') {
    const nextRequest = await rewriteGroupDetailRequest(request, db);
    const response = await handleGetMeditationGroupDetail(nextRequest, env, db);
    return await withVisibleGroupNumbers(response, db);
  }
  if (pathname === '/api/meditation/groups/review' && method === 'POST') {
    const { request: nextRequest } = await rewriteGroupBodyRequest(request, db);
    return await handleReviewMeditationGroupJoin(nextRequest, env, db);
  }

  return null;
}
