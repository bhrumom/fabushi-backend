import { jsonResponse } from '../utils/response.js';
import { requireAuthIdentity } from '../utils/auth-identity.js';

const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/;
const EVENT_KINDS = new Set(['transition', 'signal', 'media', 'participant']);
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

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
    state: row.state,
    generation: Number(row.generation),
    eventSeq: Number(row.event_seq),
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
    SELECT id, creator_user_id, peer_user_id, state, generation, event_seq,
      terminal_state, created_at, updated_at
    FROM human_call_channels
    WHERE id = ? AND (creator_user_id = ? OR peer_user_id = ?)
    LIMIT 1
  `).bind(callId, authUserId, authUserId).first();
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
    SELECT id, creator_user_id, peer_user_id, state, generation, event_seq,
      terminal_state, created_at, updated_at
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
        id, creator_user_id, peer_user_id, state, generation, event_seq,
        terminal_state, created_at, updated_at
      ) VALUES (?, ?, ?, 'invited', 0, 0, NULL, ?, ?)
    `).bind(callId, auth.userId, target.id, now, now).run();
  } catch {
    const raced = await db.prepare(`
      SELECT id, creator_user_id, peer_user_id, generation, event_seq,
        terminal_state, created_at, updated_at
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
    SELECT id, creator_user_id, peer_user_id, state, generation, event_seq,
      terminal_state, created_at, updated_at
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
  } else if (generation !== Number(call.generation)) {
    return jsonResponse({ success: false, error: '通话事件代际已过期' }, 409);
  }
  const nextSeq = Number(call.event_seq) + 1;
  const now = new Date().toISOString();
  const updateStatement = db.prepare(`
    UPDATE human_call_channels
    SET state = ?, generation = ?, event_seq = ?, terminal_state = COALESCE(?, terminal_state),
      updated_at = ?
    WHERE id = ? AND state = ? AND generation = ? AND event_seq = ? AND terminal_state IS NULL
  `).bind(
    nextState, nextGeneration, nextSeq, terminalState, now,
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
