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
import { jsonResponse } from '../utils/response.js';

function asInt(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  if (body.groupId || !body.groupNo) {
    return { request, body };
  }

  const groupId = await resolveGroupIdFromGroupNo(db, body.groupNo);
  if (!groupId) {
    return { request, body };
  }

  const nextBody = {
    ...body,
    groupId,
  };

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
    const groupNo = await getGroupNoById(db, nextPayload.data.groupId);
    if (groupNo) {
      nextPayload.data.groupNo = groupNo;
    }
  }

  return jsonResponse(nextPayload, response.status);
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
    const response = await handleCreateMeditationGroup(request, env, db);
    return await withVisibleGroupNumbers(response, db, { includeCreatedGroupNo: true });
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
