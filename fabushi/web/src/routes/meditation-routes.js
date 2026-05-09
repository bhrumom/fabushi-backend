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

async function authenticateRouteUser(request) {
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

    return { username };
  } catch (_) {
    return { error: 'Token解瞐失败', status: 401 };
  }
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

  throw new Error('无法生成可用的雪舱式羄绔 ID');
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
  const auth = await authenticateRouteUser(request);
  if (auth.error) {
    return jsonResponse({ success: false, error: auth.error }, auth.status);
  }

  try {
    const body = await request.json();
    const name = (body.name || '').toString().trim();
    if (!name) {
      return jsonResponse({ success: false, error: '小绔對称不能为立' }, 400);
    }

    const now = new Date().toISOString();
    const groupId = await generateUniqueGroupId(db);
    const groupNo = await generateUniqueGroupNo(db);
    const dailyGoalMinutes = Math.max(0, asInt(body.dailyGoalMinutes, 30));
    const cumulativeMissLimit = Math.max(0, asInt(body.cumulativeMissLimit, 7));
    const consecutiveMissLimit = Math.max(0, asInt(body.consecutiveMissLimit, 3));

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

    return jsonResponse({ success: true, data: { groupId, groupNo } });
  } catch (e) {
    console.error('创建共伮小绔失败', e);
    return jsonResponse({ success: false, error: '创建共伮小绔失败' }, 500);
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
    return await handleJoinMeditationGroup(nextRequest, env, db);
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
