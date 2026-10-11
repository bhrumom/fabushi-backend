import { jsonResponse } from '../utils/response.js';
import { requireAuthIdentity } from '../utils/auth-identity.js';

const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/;
const EVENT_KINDS = new Set(['transition', 'signal', 'media', 'participant']);
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const MEMBER_ACTIONS = new Set(['add', 'remove']);
const SFU_SESSION_PURPOSES = new Set(['publish', 'subscribe']);
const SFU_APP_ID_RE = /^[A-Fa-f0-9]{32}$/;
const SFU_PROVIDER_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,256}$/;
const SFU_TRACK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SFU_MID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SFU_MEDIA_KINDS = new Set(['audio', 'video']);
const MAX_SFU_PUBLICATIONS = 16;
const MAX_SFU_SDP_BYTES = 512 * 1024;
const SFU_PUBLIC_ERROR_CODE_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

async function requireCallAuth(request, env, db) {
  const auth = await requireAuthIdentity(request, env, db);
  if (auth.error) return auth;
  if (!Number.isFinite(auth.userId)) {
    return { error: '账号资料需要刷新后才能使用通话功能', status: 409 };
  }
  const deviceId = String(request.headers.get('x-fabushi-device-id') || '').trim();
  if (!deviceId || deviceId.length > 200) {
    return { error: '缺少有效设备标识', status: 400 };
  }
  return { ...auth, deviceId };
}

function validOpaqueId(value, regex) {
  const normalized = String(value ?? '').trim();
  return regex.test(normalized) ? normalized : null;
}

function parseGeneration(value) {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
}

function parseRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function clampLimit(value) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(parsed, 1), 200);
}

async function findUser(db, identifier) {
  const value = String(identifier ?? '').trim();
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric > 0) {
    const byId = await db.prepare(`
      SELECT id, username FROM users WHERE id = ? OR user_no = ? LIMIT 1
    `).bind(numeric, numeric).first();
    if (byId) return byId;
  }
  return await db.prepare(`
    SELECT id, username FROM users WHERE lower(username) = lower(?) LIMIT 1
  `).bind(value).first();
}

async function areFriends(db, firstUserId, secondUserId) {
  const row = await db.prepare(`
    SELECT id
    FROM friend_requests
    WHERE status = 'accepted'
      AND ((sender_user_id = ? AND recipient_user_id = ?)
        OR (sender_user_id = ? AND recipient_user_id = ?))
    LIMIT 1
  `).bind(firstUserId, secondUserId, secondUserId, firstUserId).first();
  return Boolean(row);
}

function transitionTarget(state, action) {
  if (state === 'invited' && action === 'ring') return 'ringing';
  if ((state === 'invited' || state === 'ringing') && action === 'accept') return 'negotiating';
  if ((state === 'negotiating' || state === 'reconnecting') && action === 'connected') return 'connected';
  if ((state === 'invited' || state === 'ringing') && action === 'decline') return 'ended';
  if (['invited', 'ringing', 'negotiating', 'connected', 'reconnecting'].includes(state)
      && action === 'hangup') return 'ended';
  if (['invited', 'ringing', 'negotiating', 'connected', 'reconnecting'].includes(state)
      && action === 'fail') return 'failed';
  if (['negotiating', 'connected', 'reconnecting'].includes(state)
      && action === 'reconnect') return 'reconnecting';
  if (state === 'reconnecting' && action === 'resume') return 'negotiating';
  return null;
}

function mapChannel(row) {
  return {
    callId: row.id,
    creatorUserId: row.creator_user_id,
    peerUserId: row.peer_user_id,
    creatorDeviceId: row.creator_device_id ?? null,
    peerDeviceId: row.peer_device_id ?? null,
    state: row.state,
    generation: Number(row.generation),
    eventSeq: Number(row.event_seq),
    membershipRevision: Number(row.membership_revision ?? 0),
    terminalState: row.terminal_state ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row) {
  return {
    callId: row.call_id,
    seq: Number(row.seq),
    generation: Number(row.generation),
    userId: row.user_id,
    deviceId: row.device_id,
    clientEventId: row.client_event_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}

async function readAuthorizedChannel(db, callId, authUserId) {
  return await db.prepare(`
    SELECT id, creator_user_id, peer_user_id, creator_device_id, peer_device_id,
      state, generation, event_seq, membership_revision, terminal_state, created_at, updated_at
    FROM human_call_channels
    WHERE id = ? AND (creator_user_id = ? OR peer_user_id = ?)
    LIMIT 1
  `).bind(callId, authUserId, authUserId).first();
}

function readTurnConfiguration(env) {
  const keyId = String(env?.FABUSHI_TURN_KEY_ID || '').trim();
  const apiToken = String(env?.FABUSHI_TURN_KEY_API_TOKEN || '').trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(keyId) || apiToken.length < 16 || apiToken.length > 512) {
    return null;
  }
  const configuredTtl = Number.parseInt(String(env?.FABUSHI_TURN_CREDENTIAL_TTL_SECONDS || ''), 10);
  const ttlSeconds = Number.isFinite(configuredTtl)
    ? Math.min(Math.max(configuredTtl, 300), 86400)
    : 3600;
  return { keyId, apiToken, ttlSeconds };
}

function validIceServers(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    if (urls.length === 0 || urls.length > 16 || urls.some((url) =>
      typeof url !== 'string' || !/^(stun|turn|turns):[^\s]{1,1024}$/i.test(url))) return false;
    if (entry.username != null && (typeof entry.username !== 'string' || entry.username.length > 2048)) return false;
    if (entry.credential != null && (typeof entry.credential !== 'string' || entry.credential.length > 2048)) return false;
    return true;
  });
}

function readSfuConfiguration(env) {
  const appId = String(env?.FABUSHI_REALTIME_SFU_APP_ID || '').trim();
  const appSecret = String(env?.FABUSHI_REALTIME_SFU_APP_SECRET || '').trim();
  if (!SFU_APP_ID_RE.test(appId) || appSecret.length < 16 || appSecret.length > 512) return null;
  return { appId, appSecret };
}

function mapMediaSession(row) {
  return {
    mediaSessionId: row.id,
    callId: row.call_id,
    userId: Number(row.user_id),
    deviceId: row.device_id,
    generation: Number(row.generation),
    purpose: row.purpose,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readMediaSessionByClientRequest(db, callId, userId, deviceId, clientSessionId) {
  return await db.prepare(`
    SELECT id, call_id, user_id, device_id, generation, purpose, client_session_id,
      provider_session_id, status, last_error_code, created_at, updated_at
    FROM human_call_media_sessions
    WHERE call_id = ? AND user_id = ? AND device_id = ? AND client_session_id = ?
    LIMIT 1
  `).bind(callId, userId, deviceId, clientSessionId).first();
}

async function setMediaSessionStatus(db, mediaSessionId, expectedStatus, status, {
  providerSessionId = null,
  errorCode = null,
} = {}) {
  const now = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE human_call_media_sessions
    SET status = ?, provider_session_id = COALESCE(?, provider_session_id),
      last_error_code = ?, updated_at = ?
    WHERE id = ? AND status = ?
  `).bind(status, providerSessionId, errorCode, now, mediaSessionId, expectedStatus).run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function claimMediaDeviceIfNeeded(db, call, member, auth) {
  const isCreator = Number(call.creator_user_id) === auth.userId;
  const isPeer = Number(call.peer_user_id) === auth.userId;
  if (isCreator || isPeer) {
    const claimed = isCreator ? call.creator_device_id : call.peer_device_id;
    if (claimed == null || claimed !== auth.deviceId) return false;
    return true;
  }
  if (member?.state !== 'active') return false;
  if (member.device_id != null) return member.device_id === auth.deviceId;
  const now = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE human_call_members
    SET device_id = ?, joined_generation = ?, updated_at = ?
    WHERE call_id = ? AND user_id = ? AND state = 'active'
      AND device_id IS NULL AND joined_generation <= ?
  `).bind(
    auth.deviceId, Number(call.generation), now,
    call.id, auth.userId, Number(call.generation),
  ).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function handleGetHumanCallIceServers(request, env, db, fetchImpl = fetch) {
  const auth = await requireCallAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const config = readTurnConfiguration(env);
  if (!config) {
    return jsonResponse({ success: false, error: '实时通话中继服务尚未配置' }, 503);
  }

  let upstream;
  try {
    upstream = await fetchImpl(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl: config.ttlSeconds }),
      },
    );
  } catch {
    return jsonResponse({ success: false, error: '实时通话中继凭据暂时不可用' }, 502);
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return jsonResponse({ success: false, error: '实时通话中继响应无效' }, 502);
  }
  if (!upstream.ok || !validIceServers(payload?.iceServers)) {
    return jsonResponse({ success: false, error: '实时通话中继凭据生成失败' }, 502);
  }
  const response = jsonResponse({
    success: true,
    iceServers: payload.iceServers,
    ttlSeconds: config.ttlSeconds,
  });
  response.headers.set('cache-control', 'private, no-store');
  return response;
}

export async function handleCreateHumanCall(request, env, db) {
  const auth = await requireCallAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ success: false, error: '通话请求格式无效' }, 400);
  }
  const callId = validOpaqueId(body.callId, CALL_ID_RE);
  if (!callId) return jsonResponse({ success: false, error: '通话编号无效' }, 400);
  const target = await findUser(db, body.targetUserId ?? body.targetUsername);
  if (!target) return jsonResponse({ success: false, error: '未找到通话联系人' }, 404);
  if (target.id === auth.userId) {
    return jsonResponse({ success: false, error: '不能与自己建立通话' }, 400);
  }
  if (!(await areFriends(db, auth.userId, target.id))) {
    return jsonResponse({ success: false, error: '只能与已添加的好友建立通话' }, 403);
  }

  const existing = await db.prepare(`
    SELECT id, creator_user_id, peer_user_id, creator_device_id, peer_device_id,
      state, generation, event_seq, membership_revision, terminal_state, created_at, updated_at
    FROM human_call_channels WHERE id = ? LIMIT 1
  `).bind(callId).first();
  if (existing) {
    const samePair =
      existing.creator_user_id === auth.userId && existing.peer_user_id === target.id;
    if (!samePair) {
      return jsonResponse({ success: false, error: '通话编号已被其他参与者使用' }, 409);
    }
    return jsonResponse({ success: true, deduplicated: true, call: mapChannel(existing) });
  }

  const now = new Date().toISOString();
  try {
    await db.prepare(`
      INSERT INTO human_call_channels (
        id, creator_user_id, peer_user_id, creator_device_id, peer_device_id,
        state, generation, event_seq, membership_revision, terminal_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, 'invited', 0, 0, NULL, ?, ?)
    `).bind(callId, auth.userId, target.id, auth.deviceId, now, now).run();
  } catch {
    const raced = await db.prepare(`
      SELECT id, creator_user_id, peer_user_id, creator_device_id, peer_device_id,
        state, generation, event_seq, membership_revision, terminal_state, created_at, updated_at
      FROM human_call_channels WHERE id = ? LIMIT 1
    `).bind(callId).first();
    if (raced && raced.creator_user_id === auth.userId && raced.peer_user_id === target.id) {
      return jsonResponse({ success: true, deduplicated: true, call: mapChannel(raced) });
    }
    return jsonResponse({ success: false, error: '通话创建冲突' }, 409);
  }
  const created = await readAuthorizedChannel(db, callId, auth.userId);
  if (!created) return jsonResponse({ success: false, error: '通话创建结果无法读取' }, 500);
  return jsonResponse({ success: true, deduplicated: false, call: mapChannel(created) }, 201);
}

export async function handleListHumanCalls(request, env, db) {
  const auth = await requireCallAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const url = new URL(request.url);
  const limit = clampLimit(url.searchParams.get('limit'));
  const rows = await db.prepare(`
    SELECT id, creator_user_id, peer_user_id, creator_device_id, peer_device_id,
      state, generation, event_seq, membership_revision, terminal_state, created_at, updated_at
    FROM human_call_channels
    WHERE creator_user_id = ? OR peer_user_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).bind(auth.userId, auth.userId, limit).all();
  return jsonResponse({
    success: true,
    calls: (rows.results || []).map(mapChannel),
  });
}

export async function handleGetHumanCall(request, env, db, rawCallId) {
  const auth = await requireCallAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const callId = validOpaqueId(rawCallId, CALL_ID_RE);
  if (!callId) return jsonResponse({ success: false, error: '通话编号无效' }, 400);
  const call = await readAuthorizedChannel(db, callId, auth.userId);
  if (!call) return jsonResponse({ success: false, error: '通话不存在或无权访问' }, 404);

  const url = new URL(request.url);
  const afterSeq = Number(url.searchParams.get('afterSeq') || 0);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    return jsonResponse({ success: false, error: 'afterSeq 无效' }, 400);
  }
  const limit = clampLimit(url.searchParams.get('limit'));
  const rows = await db.prepare(`
    SELECT call_id, seq, generation, user_id, device_id, client_event_id,
      kind, payload_json, created_at
    FROM human_call_events
    WHERE call_id = ? AND seq > ?
    ORDER BY seq ASC
    LIMIT ?
  `).bind(callId, afterSeq, limit).all();
  const events = (rows.results || []).map(mapEvent);
  return jsonResponse({
    success: true,
    call: mapChannel(call),
    events,
    nextAfterSeq: events.length ? events[events.length - 1].seq : afterSeq,
  });
}

export async function handleAppendHumanCallEvent(request, env, db, rawCallId) {
  const auth = await requireCallAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const callId = validOpaqueId(rawCallId, CALL_ID_RE);
  if (!callId) return jsonResponse({ success: false, error: '通话编号无效' }, 400);
  const call = await readAuthorizedChannel(db, callId, auth.userId);
  if (!call) return jsonResponse({ success: false, error: '通话不存在或无权访问' }, 404);
  if (call.terminal_state) {
    return jsonResponse({ success: false, error: '通话已结束，不能继续写入事件' }, 409);
  }

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ success: false, error: '通话事件格式无效' }, 400);
  }
  const clientEventId = validOpaqueId(body.clientEventId, EVENT_ID_RE);
  const generation = parseGeneration(body.generation);
  const kind = String(body.kind || '').trim();
  if (!clientEventId) return jsonResponse({ success: false, error: '通话事件编号无效' }, 400);
  if (generation == null) return jsonResponse({ success: false, error: '通话代际无效' }, 400);
  if (!EVENT_KINDS.has(kind)) return jsonResponse({ success: false, error: '通话事件类型无效' }, 400);
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    return jsonResponse({ success: false, error: '通话事件载荷必须是对象' }, 400);
  }
  const payloadJson = JSON.stringify(body.payload);
  if (new TextEncoder().encode(payloadJson).byteLength > MAX_EVENT_PAYLOAD_BYTES) {
    return jsonResponse({ success: false, error: '通话事件载荷过大' }, 400);
  }

  const duplicate = await db.prepare(`
    SELECT call_id, seq, generation, user_id, device_id, client_event_id,
      kind, payload_json, created_at
    FROM human_call_events
    WHERE call_id = ? AND user_id = ? AND device_id = ? AND client_event_id = ?
    LIMIT 1
  `).bind(callId, auth.userId, auth.deviceId, clientEventId).first();
  if (duplicate) {
    if (
      Number(duplicate.generation) !== generation ||
      duplicate.kind !== kind ||
      duplicate.payload_json !== payloadJson
    ) {
      return jsonResponse({ success: false, error: '重复通话事件与已接受载荷冲突' }, 409);
    }
    return jsonResponse({
      success: true,
      deduplicated: true,
      event: mapEvent(duplicate),
      call: mapChannel(call),
    });
  }

  const isCreator = Number(call.creator_user_id) === auth.userId;
  const isPeer = Number(call.peer_user_id) === auth.userId;
  const claimedDeviceId = isCreator ? call.creator_device_id : call.peer_device_id;
  let nextCreatorDeviceId = call.creator_device_id ?? null;
  let nextPeerDeviceId = call.peer_device_id ?? null;
  let nextGeneration = Number(call.generation);
  let nextState = call.state;
  let terminalState = null;

  if (kind === 'transition') {
    const action = String(body.payload.action || '').trim();
    const target = transitionTarget(call.state, action);
    if (!target) {
      return jsonResponse({ success: false, error: '通话状态转换无效' }, 409);
    }
    if (body.payload.state != null && body.payload.state !== target) {
      return jsonResponse({ success: false, error: '通话状态载荷与服务端状态机不一致' }, 409);
    }
    if (action === 'ring' && !isCreator) {
      return jsonResponse({ success: false, error: '只有发起方设备可以进入振铃状态' }, 409);
    }
    if ((action === 'accept' || action === 'decline') && !isPeer) {
      return jsonResponse({ success: false, error: '只有被叫方设备可以接受或拒绝通话' }, 409);
    }
    if (isCreator) {
      if (claimedDeviceId != null && claimedDeviceId !== auth.deviceId) {
        return jsonResponse({ success: false, error: '通话已由同账号的另一台发起设备接管' }, 409);
      }
      nextCreatorDeviceId = claimedDeviceId ?? auth.deviceId;
    } else if (action === 'accept') {
      if (claimedDeviceId != null && claimedDeviceId !== auth.deviceId) {
        return jsonResponse({ success: false, error: '通话已由同账号的另一台接听设备接管' }, 409);
      }
      nextPeerDeviceId = claimedDeviceId ?? auth.deviceId;
    } else if (action !== 'decline') {
      if (claimedDeviceId == null || claimedDeviceId !== auth.deviceId) {
        return jsonResponse({ success: false, error: '当前设备不是该通话的媒体传输设备' }, 409);
      }
    }

    if (action === 'reconnect') {
      if (generation !== Number(call.generation) + 1) {
        return jsonResponse({ success: false, error: '重连事件必须推进一个通话代际' }, 409);
      }
      nextGeneration = generation;
    } else if (generation !== Number(call.generation)) {
      return jsonResponse({ success: false, error: '通话事件代际已过期' }, 409);
    }
    nextState = target;
    terminalState = ['ended', 'failed'].includes(target) ? target : null;
  } else {
    if (generation !== Number(call.generation)) {
      return jsonResponse({ success: false, error: '通话事件代际已过期' }, 409);
    }
    if (claimedDeviceId == null || claimedDeviceId !== auth.deviceId) {
      return jsonResponse({ success: false, error: '当前设备不是该通话的媒体传输设备' }, 409);
    }
  }
  const nextSeq = Number(call.event_seq) + 1;
  const now = new Date().toISOString();
  const updateStatement = db.prepare(`
    UPDATE human_call_channels
    SET state = ?, generation = ?, event_seq = ?, terminal_state = COALESCE(?, terminal_state),
      creator_device_id = COALESCE(creator_device_id, ?),
      peer_device_id = COALESCE(peer_device_id, ?),
      updated_at = ?
    WHERE id = ? AND state = ? AND generation = ? AND event_seq = ? AND terminal_state IS NULL
  `).bind(
    nextState, nextGeneration, nextSeq, terminalState,
    nextCreatorDeviceId, nextPeerDeviceId, now,
    callId, call.state, Number(call.generation), Number(call.event_seq),
  );
  const insertStatement = db.prepare(`
    INSERT INTO human_call_events (
      call_id, seq, generation, user_id, device_id, client_event_id,
      kind, payload_json, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE changes() = 1
  `).bind(
    callId, nextSeq, generation, auth.userId, auth.deviceId,
    clientEventId, kind, payloadJson, now,
  );

  let batchResults;
  try {
    batchResults = await db.batch([updateStatement, insertStatement]);
  } catch {
    return jsonResponse({ success: false, error: '通话事件保存失败，请重试' }, 409);
  }
  const updatedChanges = Number(batchResults?.[0]?.meta?.changes || 0);
  const insertedChanges = Number(batchResults?.[1]?.meta?.changes || 0);
  if (updatedChanges !== 1 || insertedChanges !== 1) {
    return jsonResponse({ success: false, error: '通话事件并发冲突，请同步后重试' }, 409);
  }

  const event = await db.prepare(`
    SELECT call_id, seq, generation, user_id, device_id, client_event_id,
      kind, payload_json, created_at
    FROM human_call_events
    WHERE call_id = ? AND seq = ?
    LIMIT 1
  `).bind(callId, nextSeq).first();
  const refreshed = await readAuthorizedChannel(db, callId, auth.userId);
  return jsonResponse({
    success: true,
    deduplicated: false,
    event: mapEvent(event),
    call: mapChannel(refreshed),
  }, 201);
}

function mapCallMember(row) {
  return {
    callId: row.call_id,
    userId: Number(row.user_id),
    role: row.role,
    state: row.state,
    deviceId: row.device_id ?? null,
    joinedGeneration: Number(row.joined_generation),
    leftGeneration: row.left_generation == null ? null : Number(row.left_generation),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readCallChannelById(db, callId) {
  return await db.prepare(`
    SELECT id, creator_user_id, peer_user_id, creator_device_id, peer_device_id,
      state, generation, event_seq, membership_revision, terminal_state, created_at, updated_at
    FROM human_call_channels
    WHERE id = ?
    LIMIT 1
  `).bind(callId).first();
}

async function readCallMember(db, callId, userId) {
  return await db.prepare(`
    SELECT call_id, user_id, role, state, device_id, joined_generation,
      left_generation, created_at, updated_at
    FROM human_call_members
    WHERE call_id = ? AND user_id = ?
    LIMIT 1
  `).bind(callId, userId).first();
}

async function readCallMembers(db, callId) {
  const rows = await db.prepare(`
    SELECT call_id, user_id, role, state, device_id, joined_generation,
      left_generation, created_at, updated_at
    FROM human_call_members
    WHERE call_id = ?
    ORDER BY CASE role WHEN 'creator' THEN 0 ELSE 1 END, created_at ASC, user_id ASC
  `).bind(callId).all();
  return (rows.results || []).map(mapCallMember);
}

async function readMembershipAuthorizedChannel(db, callId, userId) {
  const call = await readCallChannelById(db, callId);
  if (!call) return null;
  if (Number(call.creator_user_id) === userId || Number(call.peer_user_id) === userId) return call;
  const member = await readCallMember(db, callId, userId);
  return member?.state === 'active' ? call : null;
}

export async function handleGetHumanCallMembers(request, env, db, rawCallId) {
  const auth = await requireCallAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const callId = validOpaqueId(rawCallId, CALL_ID_RE);
  if (!callId) return jsonResponse({ success: false, error: '通话编号无效' }, 400);
  const call = await readMembershipAuthorizedChannel(db, callId, auth.userId);
  if (!call) return jsonResponse({ success: false, error: '通话不存在或无权访问' }, 404);
  return jsonResponse({
    success: true,
    call: mapChannel(call),
    membershipRevision: Number(call.membership_revision ?? 0),
    members: await readCallMembers(db, callId),
  });
}

export async function handleMutateHumanCallMember(request, env, db, rawCallId) {
  const auth = await requireCallAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const callId = validOpaqueId(rawCallId, CALL_ID_RE);
  if (!callId) return jsonResponse({ success: false, error: '通话编号无效' }, 400);
  const call = await readCallChannelById(db, callId);
  if (!call || Number(call.creator_user_id) !== auth.userId) {
    return jsonResponse({ success: false, error: '通话不存在或无权管理成员' }, 404);
  }
  if (call.terminal_state) {
    return jsonResponse({ success: false, error: '通话已结束，不能修改成员' }, 409);
  }
  if (call.creator_device_id != null && call.creator_device_id !== auth.deviceId) {
    return jsonResponse({ success: false, error: '当前设备不是该通话的成员管理设备' }, 409);
  }

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ success: false, error: '成员变更请求格式无效' }, 400);
  }
  const clientMutationId = validOpaqueId(body.clientMutationId, EVENT_ID_RE);
  const generation = parseGeneration(body.generation);
  const expectedRevision = parseRevision(body.expectedMembershipRevision);
  const action = String(body.action || '').trim();
  if (!clientMutationId) return jsonResponse({ success: false, error: '成员变更编号无效' }, 400);
  if (generation == null || generation !== Number(call.generation)) {
    return jsonResponse({ success: false, error: '成员变更通话代际已过期' }, 409);
  }
  if (expectedRevision == null) return jsonResponse({ success: false, error: '成员版本无效' }, 400);
  if (!MEMBER_ACTIONS.has(action)) return jsonResponse({ success: false, error: '成员变更动作无效' }, 400);
  const target = await findUser(db, body.targetUserId ?? body.targetUsername);
  if (!target) return jsonResponse({ success: false, error: '未找到通话成员' }, 404);
  if (Number(target.id) === auth.userId) {
    return jsonResponse({ success: false, error: '不能通过成员接口移除或重复添加通话创建者' }, 400);
  }

  const duplicate = await db.prepare(`
    SELECT call_id, actor_user_id, actor_device_id, client_mutation_id,
      generation, previous_revision, new_revision, action, target_user_id, created_at
    FROM human_call_member_mutations
    WHERE call_id = ? AND actor_user_id = ? AND actor_device_id = ? AND client_mutation_id = ?
    LIMIT 1
  `).bind(callId, auth.userId, auth.deviceId, clientMutationId).first();
  if (duplicate) {
    if (
      Number(duplicate.generation) !== generation ||
      Number(duplicate.previous_revision) !== expectedRevision ||
      duplicate.action !== action ||
      Number(duplicate.target_user_id) !== Number(target.id)
    ) {
      return jsonResponse({ success: false, error: '重复成员变更与已接受载荷冲突' }, 409);
    }
    const refreshed = await readCallChannelById(db, callId);
    return jsonResponse({
      success: true,
      deduplicated: true,
      call: mapChannel(refreshed),
      membershipRevision: Number(duplicate.new_revision),
      members: await readCallMembers(db, callId),
    });
  }

  if (Number(call.membership_revision ?? 0) !== expectedRevision) {
    return jsonResponse({ success: false, error: '成员版本已过期，请同步后重试' }, 409);
  }
  if (action === 'add' && !(await areFriends(db, auth.userId, target.id))) {
    return jsonResponse({ success: false, error: '只能邀请已添加的好友加入通话' }, 403);
  }
  const currentMember = await readCallMember(db, callId, target.id);
  if (action === 'add' && currentMember?.state === 'active') {
    return jsonResponse({ success: false, error: '该用户已在通话中' }, 409);
  }
  if (action === 'remove' && currentMember?.state !== 'active') {
    return jsonResponse({ success: false, error: '该用户当前不在通话中' }, 409);
  }
  if (action === 'remove' && Number(target.id) === Number(call.peer_user_id)) {
    return jsonResponse({ success: false, error: '被叫方仍由兼容通话授权链管理，完成成员授权迁移前不能移除' }, 409);
  }

  const nextRevision = expectedRevision + 1;
  const now = new Date().toISOString();
  const membershipPredicate = action === 'add'
    ? `NOT EXISTS (
        SELECT 1 FROM human_call_members
        WHERE call_id = ? AND user_id = ? AND state = 'active'
      )`
    : `EXISTS (
        SELECT 1 FROM human_call_members
        WHERE call_id = ? AND user_id = ? AND state = 'active'
      )`;
  const updateChannel = db.prepare(`
    UPDATE human_call_channels
    SET membership_revision = ?, updated_at = ?
    WHERE id = ? AND generation = ? AND membership_revision = ? AND terminal_state IS NULL
      AND ${membershipPredicate}
  `).bind(nextRevision, now, callId, generation, expectedRevision, callId, target.id);

  const mutateMember = action === 'add'
    ? db.prepare(`
        INSERT INTO human_call_members (
          call_id, user_id, role, state, device_id, joined_generation,
          left_generation, created_at, updated_at
        )
        SELECT ?, ?, 'member', 'active', NULL, ?, NULL, ?, ?
        WHERE changes() = 1
        ON CONFLICT(call_id, user_id) DO UPDATE SET
          role = 'member',
          state = 'active',
          device_id = NULL,
          joined_generation = excluded.joined_generation,
          left_generation = NULL,
          updated_at = excluded.updated_at
        WHERE human_call_members.state <> 'active'
      `).bind(callId, target.id, generation, now, now)
    : db.prepare(`
        UPDATE human_call_members
        SET state = 'left', device_id = NULL, left_generation = ?, updated_at = ?
        WHERE call_id = ? AND user_id = ? AND state = 'active' AND changes() = 1
      `).bind(generation, now, callId, target.id);

  const recordMutation = db.prepare(`
    INSERT INTO human_call_member_mutations (
      call_id, actor_user_id, actor_device_id, client_mutation_id,
      generation, previous_revision, new_revision, action, target_user_id, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE changes() = 1
  `).bind(
    callId, auth.userId, auth.deviceId, clientMutationId,
    generation, expectedRevision, nextRevision, action, target.id, now,
  );

  let results;
  try {
    results = await db.batch([updateChannel, mutateMember, recordMutation]);
  } catch {
    return jsonResponse({ success: false, error: '成员变更保存失败，请同步后重试' }, 409);
  }
  if (results.some((result) => Number(result?.meta?.changes || 0) !== 1)) {
    return jsonResponse({ success: false, error: '成员变更并发冲突，请同步后重试' }, 409);
  }
  const refreshed = await readCallChannelById(db, callId);
  return jsonResponse({
    success: true,
    deduplicated: false,
    call: mapChannel(refreshed),
    membershipRevision: nextRevision,
    members: await readCallMembers(db, callId),
  }, 201);
}

export async function handleCreateHumanCallMediaSession(request, env, db, rawCallId, fetchImpl = fetch) {
  const auth = await requireCallAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const config = readSfuConfiguration(env);
  if (!config) {
    return jsonResponse({ success: false, error: '群组通话媒体服务尚未配置' }, 503);
  }
  const callId = validOpaqueId(rawCallId, CALL_ID_RE);
  if (!callId) return jsonResponse({ success: false, error: '通话编号无效' }, 400);
  const call = await readMembershipAuthorizedChannel(db, callId, auth.userId);
  if (!call) return jsonResponse({ success: false, error: '通话不存在或无权访问' }, 404);
  if (call.terminal_state) {
    return jsonResponse({ success: false, error: '通话已结束，不能创建媒体会话' }, 409);
  }
  const member = await readCallMember(db, callId, auth.userId);
  if (member?.state !== 'active') {
    return jsonResponse({ success: false, error: '当前账号不是活跃通话成员' }, 403);
  }

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ success: false, error: '媒体会话请求格式无效' }, 400);
  }
  const clientSessionId = validOpaqueId(body.clientSessionId, EVENT_ID_RE);
  const generation = parseGeneration(body.generation);
  const purpose = String(body.purpose || '').trim();
  if (!clientSessionId) return jsonResponse({ success: false, error: '媒体会话请求编号无效' }, 400);
  if (generation == null || generation !== Number(call.generation)) {
    return jsonResponse({ success: false, error: '媒体会话通话代际已过期' }, 409);
  }
  if (!SFU_SESSION_PURPOSES.has(purpose)) {
    return jsonResponse({ success: false, error: '媒体会话用途无效' }, 400);
  }

  if (!(await claimMediaDeviceIfNeeded(db, call, member, auth))) {
    return jsonResponse({ success: false, error: '当前设备未持有该成员的媒体会话所有权' }, 409);
  }

  const existing = await readMediaSessionByClientRequest(
    db, callId, auth.userId, auth.deviceId, clientSessionId,
  );
  if (existing) {
    if (Number(existing.generation) !== generation || existing.purpose !== purpose) {
      return jsonResponse({ success: false, error: '重复媒体会话请求与已保存参数冲突' }, 409);
    }
    if (existing.status === 'ready') {
      const response = jsonResponse({ success: true, deduplicated: true, mediaSession: mapMediaSession(existing) });
      response.headers.set('cache-control', 'private, no-store');
      return response;
    }
    if (existing.status === 'pending' || existing.status === 'uncertain') {
      return jsonResponse({
        success: false,
        error: '媒体会话分配结果尚不确定，禁止自动重试',
        mediaSession: mapMediaSession(existing),
      }, 409);
    }
    return jsonResponse({
      success: false,
      error: '该媒体会话请求已失败或关闭，请使用新的请求编号',
      mediaSession: mapMediaSession(existing),
    }, 409);
  }

  const mediaSessionId = `media_${crypto.randomUUID().replaceAll('-', '')}`;
  const now = new Date().toISOString();
  try {
    await db.prepare(`
      INSERT INTO human_call_media_sessions (
        id, call_id, user_id, device_id, generation, purpose, client_session_id,
        provider_session_id, status, last_error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?)
    `).bind(
      mediaSessionId, callId, auth.userId, auth.deviceId, generation, purpose,
      clientSessionId, now, now,
    ).run();
  } catch {
    const raced = await readMediaSessionByClientRequest(
      db, callId, auth.userId, auth.deviceId, clientSessionId,
    );
    if (raced?.status === 'ready') {
      const response = jsonResponse({ success: true, deduplicated: true, mediaSession: mapMediaSession(raced) });
      response.headers.set('cache-control', 'private, no-store');
      return response;
    }
    return jsonResponse({
      success: false,
      error: '媒体会话分配发生并发冲突，请先同步状态',
      ...(raced ? { mediaSession: mapMediaSession(raced) } : {}),
    }, 409);
  }

  let upstream;
  try {
    upstream = await fetchImpl(
      `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(config.appId)}/sessions/new?correlationId=${encodeURIComponent(mediaSessionId)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.appSecret}` },
      },
    );
  } catch {
    await setMediaSessionStatus(db, mediaSessionId, 'pending', 'uncertain', { errorCode: 'network_outcome_unknown' });
    return jsonResponse({
      success: false,
      error: '媒体会话分配结果未知，禁止自动重试',
      mediaSession: {
        mediaSessionId, callId, userId: auth.userId, deviceId: auth.deviceId,
        generation, purpose, status: 'uncertain', createdAt: now, updatedAt: now,
      },
    }, 502);
  }

  let payload;
  try { payload = await upstream.json(); } catch { payload = null; }
  const providerSessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!upstream.ok || !SFU_PROVIDER_SESSION_ID_RE.test(providerSessionId)) {
    await setMediaSessionStatus(db, mediaSessionId, 'pending', 'failed', {
      errorCode: `provider_http_${upstream.status}`,
    });
    return jsonResponse({ success: false, error: '媒体会话服务拒绝了分配请求' }, 502);
  }

  if (!(await setMediaSessionStatus(db, mediaSessionId, 'pending', 'ready', { providerSessionId }))) {
    return jsonResponse({
      success: false,
      error: '媒体会话已由并发状态变更接管，请同步后继续',
    }, 409);
  }
  const ready = await readMediaSessionByClientRequest(
    db, callId, auth.userId, auth.deviceId, clientSessionId,
  );
  if (!ready || ready.status !== 'ready') {
    return jsonResponse({ success: false, error: '媒体会话保存后无法读取' }, 500);
  }
  const response = jsonResponse({ success: true, deduplicated: false, mediaSession: mapMediaSession(ready) }, 201);
  response.headers.set('cache-control', 'private, no-store');
  return response;
}

function validSfuSessionDescription(value, expectedType) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = String(value.type || '').trim();
  const sdp = typeof value.sdp === 'string' ? value.sdp : '';
  if (type !== expectedType || !sdp || new TextEncoder().encode(sdp).byteLength > MAX_SFU_SDP_BYTES) {
    return null;
  }
  return { type, sdp };
}

function normalizePublicationIntents(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SFU_PUBLICATIONS) return null;
  const seenClientIds = new Set();
  const seenTrackNames = new Set();
  const seenMids = new Set();
  const normalized = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const clientPublicationId = validOpaqueId(raw.clientPublicationId, EVENT_ID_RE);
    const trackName = String(raw.trackName || '').trim();
    const mid = String(raw.mid || '').trim();
    const mediaKind = String(raw.mediaKind || '').trim();
    if (!clientPublicationId || !SFU_TRACK_NAME_RE.test(trackName)
        || !SFU_MID_RE.test(mid) || !SFU_MEDIA_KINDS.has(mediaKind)) return null;
    if (seenClientIds.has(clientPublicationId) || seenTrackNames.has(trackName) || seenMids.has(mid)) return null;
    seenClientIds.add(clientPublicationId);
    seenTrackNames.add(trackName);
    seenMids.add(mid);
    normalized.push({ clientPublicationId, trackName, mid, mediaKind });
  }
  return normalized;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sanitizeProviderErrorCode(value) {
  const code = String(value || '').trim();
  return SFU_PUBLIC_ERROR_CODE_RE.test(code) ? code : 'provider_item_failed';
}

async function readOwnedMediaSession(db, callId, mediaSessionId, userId, deviceId) {
  return await db.prepare(`
    SELECT id, call_id, user_id, device_id, generation, purpose, client_session_id,
      provider_session_id, status, mutation_state, last_error_code, created_at, updated_at
    FROM human_call_media_sessions
    WHERE id = ? AND call_id = ? AND user_id = ? AND device_id = ?
    LIMIT 1
  `).bind(mediaSessionId, callId, userId, deviceId).first();
}

async function readMediaOperation(db, mediaSessionId, clientOperationId) {
  return await db.prepare(`
    SELECT id, media_session_id, call_id, user_id, device_id, generation,
      client_operation_id, request_fingerprint, status, result_json,
      response_session_description_json, last_error_code, created_at, updated_at
    FROM human_call_media_operations
    WHERE media_session_id = ? AND client_operation_id = ?
    LIMIT 1
  `).bind(mediaSessionId, clientOperationId).first();
}

function mapStoredMediaOperation(operation, deduplicated = false) {
  let results = [];
  try {
    results = operation?.result_json ? JSON.parse(operation.result_json) : [];
  } catch {
    results = [];
  }
  let sessionDescription;
  try {
    sessionDescription = operation?.response_session_description_json
      ? JSON.parse(operation.response_session_description_json)
      : undefined;
  } catch {
    sessionDescription = undefined;
  }
  return {
    success: operation?.status === 'awaiting_endpoint_apply' || operation?.status === 'applied',
    deduplicated,
    operation: {
      clientOperationId: operation.client_operation_id,
      generation: Number(operation.generation),
      status: operation.status,
    },
    ...(sessionDescription ? { sessionDescription } : {}),
    results,
  };
}

async function retireUncertainMediaOperation(db, mediaSessionId, operationId, errorCode) {
  const now = new Date().toISOString();
  try {
    await db.batch([
      db.prepare(`
        UPDATE human_call_media_operations
        SET status = 'uncertain', last_error_code = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(errorCode, now, operationId),
      db.prepare(`
        UPDATE human_call_media_sessions
        SET status = 'uncertain', mutation_state = 'retired',
          last_error_code = ?, updated_at = ?
        WHERE id = ? AND mutation_state = 'mutating'
      `).bind(errorCode, now, mediaSessionId),
    ]);
  } catch {
    // The caller already fails closed; reconciliation must inspect both durable rows.
  }
}

export async function handlePublishHumanCallMedia(
  request, env, db, rawCallId, rawMediaSessionId, fetchImpl = fetch,
) {
  const auth = await requireCallAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const config = readSfuConfiguration(env);
  if (!config) return jsonResponse({ success: false, error: '群组通话媒体服务尚未配置' }, 503);

  const callId = validOpaqueId(rawCallId, CALL_ID_RE);
  const mediaSessionId = validOpaqueId(rawMediaSessionId, CALL_ID_RE);
  if (!callId || !mediaSessionId) return jsonResponse({ success: false, error: '媒体发布路径无效' }, 400);

  const call = await readMembershipAuthorizedChannel(db, callId, auth.userId);
  if (!call) return jsonResponse({ success: false, error: '通话不存在或无权访问' }, 404);
  if (call.terminal_state) return jsonResponse({ success: false, error: '通话已结束，不能发布媒体' }, 409);
  const member = await readCallMember(db, callId, auth.userId);
  if (member?.state !== 'active') return jsonResponse({ success: false, error: '当前账号不是活跃通话成员' }, 403);

  const mediaSession = await readOwnedMediaSession(db, callId, mediaSessionId, auth.userId, auth.deviceId);
  if (!mediaSession) return jsonResponse({ success: false, error: '媒体会话不存在或不属于当前设备' }, 404);
  if (mediaSession.status !== 'ready' || mediaSession.purpose !== 'publish'
      || !SFU_PROVIDER_SESSION_ID_RE.test(String(mediaSession.provider_session_id || ''))) {
    return jsonResponse({ success: false, error: '媒体会话当前不能发布媒体' }, 409);
  }

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ success: false, error: '媒体发布请求格式无效' }, 400);
  }
  const clientOperationId = validOpaqueId(body.clientOperationId, EVENT_ID_RE);
  const generation = parseGeneration(body.generation);
  const sessionDescription = validSfuSessionDescription(body.sessionDescription, 'offer');
  const publications = normalizePublicationIntents(body.publications);
  if (!clientOperationId) return jsonResponse({ success: false, error: '媒体发布操作编号无效' }, 400);
  if (generation == null || generation !== Number(call.generation)
      || generation !== Number(mediaSession.generation)) {
    return jsonResponse({ success: false, error: '媒体发布通话代际已过期' }, 409);
  }
  if (!sessionDescription) return jsonResponse({ success: false, error: '媒体发布 SDP offer 无效' }, 400);
  if (!publications) return jsonResponse({ success: false, error: '媒体发布轨道列表无效' }, 400);

  const requestFingerprint = await sha256Hex(JSON.stringify({
    generation, sessionDescription, publications,
  }));
  const duplicate = await readMediaOperation(db, mediaSessionId, clientOperationId);
  if (duplicate) {
    if (duplicate.request_fingerprint !== requestFingerprint
        || Number(duplicate.generation) !== generation) {
      return jsonResponse({ success: false, error: '重复媒体发布操作与已保存参数冲突' }, 409);
    }
    if (duplicate.status === 'awaiting_endpoint_apply' || duplicate.status === 'applied') {
      const response = jsonResponse(mapStoredMediaOperation(duplicate, true));
      response.headers.set('cache-control', 'private, no-store');
      return response;
    }
    return jsonResponse({
      success: false,
      error: duplicate.status === 'uncertain'
        ? '媒体发布结果未知，已停用该媒体会话，禁止自动重试'
        : '媒体发布操作尚未完成或已失败，请同步后使用新的操作编号',
      operation: { clientOperationId, generation, status: duplicate.status },
    }, 409);
  }

  if (mediaSession.mutation_state !== 'idle') {
    return jsonResponse({ success: false, error: '媒体会话已有未完成变更，请先完成当前 SDP 交换' }, 409);
  }

  const operationId = 'mediaop_' + crypto.randomUUID().replaceAll('-', '');
  const now = new Date().toISOString();
  let claimed;
  try {
    claimed = await db.batch([
      db.prepare(`
        UPDATE human_call_media_sessions
        SET mutation_state = 'mutating', updated_at = ?
        WHERE id = ? AND call_id = ? AND user_id = ? AND device_id = ?
          AND generation = ? AND purpose = 'publish' AND status = 'ready' AND mutation_state = 'idle'
      `).bind(now, mediaSessionId, callId, auth.userId, auth.deviceId, generation),
      db.prepare(`
        INSERT INTO human_call_media_operations (
          id, media_session_id, call_id, user_id, device_id, generation,
          client_operation_id, request_fingerprint, status, result_json,
          response_session_description_json, last_error_code, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?
        WHERE changes() = 1
      `).bind(
        operationId, mediaSessionId, callId, auth.userId, auth.deviceId, generation,
        clientOperationId, requestFingerprint, now, now,
      ),
    ]);
  } catch {
    const raced = await readMediaOperation(db, mediaSessionId, clientOperationId);
    if (raced && raced.request_fingerprint === requestFingerprint
        && (raced.status === 'awaiting_endpoint_apply' || raced.status === 'applied')) {
      const response = jsonResponse(mapStoredMediaOperation(raced, true));
      response.headers.set('cache-control', 'private, no-store');
      return response;
    }
    return jsonResponse({ success: false, error: '媒体发布操作并发冲突，请同步后重试' }, 409);
  }
  if (claimed.some((result) => Number(result?.meta?.changes || 0) !== 1)) {
    return jsonResponse({ success: false, error: '媒体发布操作并发冲突，请同步后重试' }, 409);
  }

  let upstream;
  try {
    upstream = await fetchImpl(
      `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(config.appId)}/sessions/${encodeURIComponent(mediaSession.provider_session_id)}/tracks/new`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.appSecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionDescription,
          tracks: publications.map(({ trackName, mid }) => ({ location: 'local', mid, trackName })),
        }),
      },
    );
  } catch {
    await retireUncertainMediaOperation(db, mediaSessionId, operationId, 'network_outcome_unknown');
    return jsonResponse({ success: false, error: '媒体发布结果未知，已停用该媒体会话，禁止自动重试' }, 502);
  }

  let providerPayload;
  try { providerPayload = await upstream.json(); } catch { providerPayload = null; }
  if (!upstream.ok || !providerPayload || providerPayload.errorCode || !Array.isArray(providerPayload.tracks)) {
    await retireUncertainMediaOperation(
      db, mediaSessionId, operationId,
      sanitizeProviderErrorCode(providerPayload?.errorCode || `provider_http_${upstream.status}`),
    );
    return jsonResponse({ success: false, error: '媒体服务返回了不确定结果，已停用该媒体会话' }, 502);
  }

  const requestedByTrack = new Map(publications.map((item) => [item.trackName, item]));
  const providerByTrack = new Map();
  for (const item of providerPayload.tracks) {
    const trackName = String(item?.trackName || '').trim();
    if (!requestedByTrack.has(trackName) || providerByTrack.has(trackName)) {
      await retireUncertainMediaOperation(db, mediaSessionId, operationId, 'provider_result_identity_mismatch');
      return jsonResponse({ success: false, error: '媒体服务返回无法安全对应的轨道结果' }, 502);
    }
    providerByTrack.set(trackName, item);
  }
  if (providerByTrack.size !== publications.length) {
    await retireUncertainMediaOperation(db, mediaSessionId, operationId, 'provider_result_incomplete');
    return jsonResponse({ success: false, error: '媒体服务返回不完整轨道结果，已停用该媒体会话' }, 502);
  }

  const publicResults = [];
  const successfulRows = [];
  for (const intent of publications) {
    const item = providerByTrack.get(intent.trackName);
    if (item.errorCode) {
      publicResults.push({
        clientPublicationId: intent.clientPublicationId,
        status: 'failed',
        errorCode: sanitizeProviderErrorCode(item.errorCode),
      });
      continue;
    }
    const publicationId = 'pub_' + crypto.randomUUID().replaceAll('-', '');
    publicResults.push({
      publicationId,
      clientPublicationId: intent.clientPublicationId,
      trackName: intent.trackName,
      mid: intent.mid,
      mediaKind: intent.mediaKind,
      status: 'ready',
    });
    successfulRows.push({ publicationId, ...intent });
  }

  const answer = successfulRows.length
    ? validSfuSessionDescription(providerPayload.sessionDescription, 'answer')
    : null;
  if (successfulRows.length && !answer) {
    await retireUncertainMediaOperation(db, mediaSessionId, operationId, 'provider_answer_missing');
    return jsonResponse({ success: false, error: '媒体服务未返回可安全应用的 SDP answer' }, 502);
  }

  const updatedAt = new Date().toISOString();
  if (successfulRows.length === 0) {
    let failed;
    try {
      failed = await db.batch([
        db.prepare(`
          UPDATE human_call_media_operations
          SET status = 'failed', result_json = ?, last_error_code = 'all_tracks_rejected', updated_at = ?
          WHERE id = ? AND status = 'pending'
        `).bind(JSON.stringify(publicResults), updatedAt, operationId),
        db.prepare(`
          UPDATE human_call_media_sessions
          SET mutation_state = 'idle', last_error_code = 'all_tracks_rejected', updated_at = ?
          WHERE id = ? AND status = 'ready' AND mutation_state = 'mutating'
        `).bind(updatedAt, mediaSessionId),
      ]);
    } catch {
      await retireUncertainMediaOperation(db, mediaSessionId, operationId, 'result_persist_failed');
      return jsonResponse({ success: false, error: '媒体发布结果保存失败，已停用该媒体会话' }, 502);
    }
    if (failed.some((result) => Number(result?.meta?.changes || 0) !== 1)) {
      await retireUncertainMediaOperation(db, mediaSessionId, operationId, 'result_persist_conflict');
      return jsonResponse({ success: false, error: '媒体发布结果保存发生冲突，已停用该媒体会话' }, 502);
    }
    return jsonResponse({
      success: false,
      error: '媒体服务拒绝了全部发布轨道',
      operation: { clientOperationId, generation, status: 'failed' },
      results: publicResults,
    }, 502);
  }

  const publicationStatements = successfulRows.map((row) => db.prepare(`
    INSERT INTO human_call_media_publications (
      id, media_session_id, operation_id, call_id, user_id, device_id, generation,
      client_publication_id, track_name, mid, media_kind, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
  `).bind(
    row.publicationId, mediaSessionId, operationId, callId, auth.userId, auth.deviceId,
    generation, row.clientPublicationId, row.trackName, row.mid, row.mediaKind, updatedAt, updatedAt,
  ));
  let persisted;
  try {
    persisted = await db.batch([
      db.prepare(`
        UPDATE human_call_media_operations
        SET status = 'awaiting_endpoint_apply', result_json = ?,
          response_session_description_json = ?, last_error_code = NULL, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(JSON.stringify(publicResults), JSON.stringify(answer), updatedAt, operationId),
      ...publicationStatements,
      db.prepare(`
        UPDATE human_call_media_sessions
        SET mutation_state = 'awaiting_endpoint_apply', last_error_code = NULL, updated_at = ?
        WHERE id = ? AND status = 'ready' AND mutation_state = 'mutating'
      `).bind(updatedAt, mediaSessionId),
    ]);
  } catch {
    await retireUncertainMediaOperation(db, mediaSessionId, operationId, 'result_persist_failed');
    return jsonResponse({ success: false, error: '媒体发布结果保存失败，已停用该媒体会话' }, 502);
  }
  if (persisted.some((result) => Number(result?.meta?.changes || 0) !== 1)) {
    await retireUncertainMediaOperation(db, mediaSessionId, operationId, 'result_persist_conflict');
    return jsonResponse({ success: false, error: '媒体发布结果保存发生冲突，已停用该媒体会话' }, 502);
  }

  const response = jsonResponse({
    success: true,
    deduplicated: false,
    operation: { clientOperationId, generation, status: 'awaiting_endpoint_apply' },
    sessionDescription: answer,
    results: publicResults,
  }, 201);
  response.headers.set('cache-control', 'private, no-store');
  return response;
}

export async function handleAcknowledgeHumanCallMediaOperationApplied(
  request, env, db, rawCallId, rawMediaSessionId, rawClientOperationId,
) {
  const auth = await requireCallAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const callId = validOpaqueId(rawCallId, CALL_ID_RE);
  const mediaSessionId = validOpaqueId(rawMediaSessionId, CALL_ID_RE);
  const clientOperationId = validOpaqueId(rawClientOperationId, EVENT_ID_RE);
  if (!callId || !mediaSessionId || !clientOperationId) {
    return jsonResponse({ success: false, error: '媒体发布确认路径无效' }, 400);
  }
  const call = await readMembershipAuthorizedChannel(db, callId, auth.userId);
  if (!call) return jsonResponse({ success: false, error: '通话不存在或无权访问' }, 404);
  if (call.terminal_state) return jsonResponse({ success: false, error: '通话已结束，不能确认媒体发布' }, 409);
  const member = await readCallMember(db, callId, auth.userId);
  if (member?.state !== 'active') return jsonResponse({ success: false, error: '当前账号不是活跃通话成员' }, 403);
  const mediaSession = await readOwnedMediaSession(db, callId, mediaSessionId, auth.userId, auth.deviceId);
  if (!mediaSession) return jsonResponse({ success: false, error: '媒体会话不存在或不属于当前设备' }, 404);

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ success: false, error: '媒体发布确认格式无效' }, 400);
  }
  const generation = parseGeneration(body.generation);
  if (generation == null || generation !== Number(call.generation)
      || generation !== Number(mediaSession.generation)) {
    return jsonResponse({ success: false, error: '媒体发布确认通话代际已过期' }, 409);
  }

  const operation = await readMediaOperation(db, mediaSessionId, clientOperationId);
  if (!operation || Number(operation.user_id) !== auth.userId
      || operation.device_id !== auth.deviceId || Number(operation.generation) !== generation) {
    return jsonResponse({ success: false, error: '媒体发布操作不存在或无权确认' }, 404);
  }
  if (operation.status === 'applied') {
    const response = jsonResponse(mapStoredMediaOperation(operation, true));
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
  if (operation.status !== 'awaiting_endpoint_apply'
      || mediaSession.status !== 'ready'
      || mediaSession.mutation_state !== 'awaiting_endpoint_apply') {
    return jsonResponse({ success: false, error: '媒体发布操作当前不能确认应用' }, 409);
  }

  const now = new Date().toISOString();
  let results;
  try {
    results = await db.batch([
      db.prepare(`
        UPDATE human_call_media_operations
        SET status = 'applied', response_session_description_json = NULL, updated_at = ?
        WHERE id = ? AND status = 'awaiting_endpoint_apply'
      `).bind(now, operation.id),
      db.prepare(`
        UPDATE human_call_media_sessions
        SET mutation_state = 'idle', updated_at = ?
        WHERE id = ? AND status = 'ready' AND mutation_state = 'awaiting_endpoint_apply'
          AND generation = ?
      `).bind(now, mediaSessionId, generation),
    ]);
  } catch {
    return jsonResponse({ success: false, error: '媒体发布确认并发冲突，请同步后重试' }, 409);
  }
  if (results.some((result) => Number(result?.meta?.changes || 0) !== 1)) {
    return jsonResponse({ success: false, error: '媒体发布确认并发冲突，请同步后重试' }, 409);
  }
  const applied = await readMediaOperation(db, mediaSessionId, clientOperationId);
  const response = jsonResponse(mapStoredMediaOperation(applied, false));
  response.headers.set('cache-control', 'private, no-store');
  return response;
}

