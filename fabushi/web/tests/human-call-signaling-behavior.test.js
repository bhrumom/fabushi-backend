import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleAppendHumanCallEvent,
  handleCreateHumanCall,
  handleGetHumanCall,
} from '../src/handlers/call-signaling.js';

const ALICE = { id: 1, username: 'alice' };
const BOB = { id: 2, username: 'bob' };
const CAROL = { id: 3, username: 'carol' };

function makeRequest(url, user, deviceId, body) {
  return new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-test-user-id': String(user.id),
      'x-test-username': user.username,
      'x-fabushi-device-id': deviceId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function createDb() {
  const state = {
    users: [ALICE, BOB, CAROL],
    friends: new Set(['1:2', '2:1']),
    calls: new Map(),
    events: [],
  };
  const prepare = (sql) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    let params = [];
    return {
      bind(...values) { params = values; return this; },
      async first() {
        if (q.includes('FROM users WHERE id = ? OR user_no = ?')) {
          return state.users.find((u) => u.id === Number(params[0])) || null;
        }
        if (q.includes('FROM users WHERE lower(username) = lower(?)')) {
          return state.users.find((u) => u.username.toLowerCase() === String(params[0]).toLowerCase()) || null;
        }
        if (q.includes('FROM friend_requests')) {
          return state.friends.has(`${Number(params[0])}:${Number(params[1])}`) ? { id: 1 } : null;
        }
        if (q.includes('FROM human_call_channels WHERE id = ? LIMIT 1')) {
          return state.calls.get(String(params[0])) || null;
        }
        if (q.includes('FROM human_call_channels') && q.includes('(creator_user_id = ? OR peer_user_id = ?)')) {
          const call = state.calls.get(String(params[0]));
          return call && (call.creator_user_id === Number(params[1]) || call.peer_user_id === Number(params[2]))
            ? { ...call } : null;
        }
        if (q.includes('FROM human_call_events') && q.includes('client_event_id = ?')) {
          return state.events.find((e) =>
            e.call_id === String(params[0]) &&
            e.user_id === Number(params[1]) &&
            e.device_id === String(params[2]) &&
            e.client_event_id === String(params[3])) || null;
        }
        if (q.includes('FROM human_call_events') && q.includes('seq = ?')) {
          return state.events.find((e) => e.call_id === String(params[0]) && e.seq === Number(params[1])) || null;
        }
        throw new Error(`unhandled first query: ${q}`);
      },
      async all() {
        if (q.includes('FROM human_call_events') && q.includes('seq > ?')) {
          return {
            results: state.events
              .filter((e) => e.call_id === String(params[0]) && e.seq > Number(params[1]))
              .sort((a, b) => a.seq - b.seq)
              .slice(0, Number(params[2]))
              .map((e) => ({ ...e })),
          };
        }
        throw new Error(`unhandled all query: ${q}`);
      },
      async run() {
        if (q.startsWith('INSERT INTO human_call_channels')) {
          const [id, creator, peer, createdAt, updatedAt] = params;
          if (state.calls.has(id)) throw new Error('constraint');
          state.calls.set(id, {
            id, creator_user_id: Number(creator), peer_user_id: Number(peer),
            generation: 0, event_seq: 0, terminal_state: null,
            created_at: createdAt, updated_at: updatedAt,
          });
          return { meta: { changes: 1 } };
        }
        if (q.startsWith('UPDATE human_call_channels SET generation = ?') && q.includes('terminal_state = COALESCE')) {
          const [generation, eventSeq, terminalState, updatedAt, id, expectedGeneration, expectedSeq] = params;
          const call = state.calls.get(id);
          if (!call || call.terminal_state || call.generation !== Number(expectedGeneration) || call.event_seq !== Number(expectedSeq)) {
            return { meta: { changes: 0 } };
          }
          call.generation = Number(generation);
          call.event_seq = Number(eventSeq);
          if (terminalState != null) call.terminal_state = terminalState;
          call.updated_at = updatedAt;
          return { meta: { changes: 1 } };
        }
        if (q.startsWith('UPDATE human_call_channels SET generation = ?') && q.includes('terminal_state = NULL')) {
          const [generation, eventSeq, updatedAt, id, expectedGeneration, expectedSeq] = params;
          const call = state.calls.get(id);
          if (call && call.generation === Number(expectedGeneration) && call.event_seq === Number(expectedSeq)) {
            call.generation = Number(generation);
            call.event_seq = Number(eventSeq);
            call.terminal_state = null;
            call.updated_at = updatedAt;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (q.startsWith('INSERT INTO human_call_events')) {
          const [callId, seq, generation, userId, deviceId, clientEventId, kind, payloadJson, createdAt] = params;
          if (state.events.some((e) => e.call_id === callId && (
            e.seq === Number(seq) ||
            (e.user_id === Number(userId) && e.device_id === deviceId && e.client_event_id === clientEventId)
          ))) throw new Error('constraint');
          state.events.push({
            call_id: callId, seq: Number(seq), generation: Number(generation),
            user_id: Number(userId), device_id: deviceId, client_event_id: clientEventId,
            kind, payload_json: payloadJson, created_at: createdAt,
          });
          return { meta: { changes: 1 } };
        }
        throw new Error(`unhandled run query: ${q}`);
      },
    };
  };
  return { state, prepare };
}

const ENV = { TEST_AUTH_FROM_HEADERS: true };

test('call create is friend-scoped and stable across devices', async () => {
  const db = createDb();
  const callId = 'call-phase1-0001';
  const first = await handleCreateHumanCall(
    makeRequest('https://api.example.com/api/social/calls', ALICE, 'alice-laptop', { callId, targetUserId: BOB.id }),
    ENV, db,
  );
  assert.equal(first.status, 201);
  const retry = await handleCreateHumanCall(
    makeRequest('https://api.example.com/api/social/calls', ALICE, 'alice-phone', { callId, targetUserId: BOB.id }),
    ENV, db,
  );
  const retried = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retried.deduplicated, true);

  const denied = await handleCreateHumanCall(
    makeRequest('https://api.example.com/api/social/calls', ALICE, 'alice-laptop', { callId: 'call-phase1-0002', targetUserId: CAROL.id }),
    ENV, db,
  );
  assert.equal(denied.status, 403);
});

test('ordered events converge across participant devices with generation and idempotency fences', async () => {
  const db = createDb();
  const callId = 'call-phase1-1001';
  await handleCreateHumanCall(
    makeRequest('https://api.example.com/api/social/calls', ALICE, 'alice-laptop', { callId, targetUserId: BOB.id }),
    ENV, db,
  );

  const signal = await handleAppendHumanCallEvent(
    makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-laptop', {
      clientEventId: 'event-offer-1',
      generation: 0,
      kind: 'signal',
      payload: { type: 'offer', sdp: 'opaque-offer' },
    }),
    ENV, db, callId,
  );
  const signalPayload = await signal.json();
  assert.equal(signal.status, 201);
  assert.equal(signalPayload.event.seq, 1);

  const replay = await handleAppendHumanCallEvent(
    makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-laptop', {
      clientEventId: 'event-offer-1',
      generation: 0,
      kind: 'signal',
      payload: { type: 'offer', sdp: 'opaque-offer' },
    }),
    ENV, db, callId,
  );
  assert.equal((await replay.json()).deduplicated, true);

  const conflict = await handleAppendHumanCallEvent(
    makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-laptop', {
      clientEventId: 'event-offer-1',
      generation: 0,
      kind: 'signal',
      payload: { type: 'offer', sdp: 'different' },
    }),
    ENV, db, callId,
  );
  assert.equal(conflict.status, 409);

  const reconnect = await handleAppendHumanCallEvent(
    makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-phone', {
      clientEventId: 'event-reconnect-1',
      generation: 1,
      kind: 'transition',
      payload: { action: 'reconnect', state: 'reconnecting' },
    }),
    ENV, db, callId,
  );
  assert.equal(reconnect.status, 201);

  const stale = await handleAppendHumanCallEvent(
    makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, BOB, 'bob-phone', {
      clientEventId: 'event-answer-stale',
      generation: 0,
      kind: 'signal',
      payload: { type: 'answer' },
    }),
    ENV, db, callId,
  );
  assert.equal(stale.status, 409);

  const peer = await handleAppendHumanCallEvent(
    makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, BOB, 'bob-phone', {
      clientEventId: 'event-answer-1',
      generation: 1,
      kind: 'signal',
      payload: { type: 'answer' },
    }),
    ENV, db, callId,
  );
  assert.equal(peer.status, 201);

  for (const deviceId of ['alice-laptop', 'alice-phone']) {
    const synced = await handleGetHumanCall(
      makeRequest(`https://api.example.com/api/social/calls/${callId}?afterSeq=1&limit=50`, ALICE, deviceId),
      ENV, db, callId,
    );
    const payload = await synced.json();
    assert.equal(synced.status, 200);
    assert.deepEqual(payload.events.map((event) => event.seq), [2, 3]);
    assert.equal(payload.call.generation, 1);
  }

  const outsider = await handleGetHumanCall(
    makeRequest(`https://api.example.com/api/social/calls/${callId}`, CAROL, 'carol-phone'),
    ENV, db, callId,
  );
  assert.equal(outsider.status, 404);
});

test('terminal transition fences later mutations', async () => {
  const db = createDb();
  const callId = 'call-phase1-2001';
  await handleCreateHumanCall(
    makeRequest('https://api.example.com/api/social/calls', ALICE, 'alice-laptop', { callId, targetUserId: BOB.id }),
    ENV, db,
  );
  const ended = await handleAppendHumanCallEvent(
    makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, BOB, 'bob-phone', {
      clientEventId: 'event-end-1',
      generation: 0,
      kind: 'transition',
      payload: { action: 'hangup', state: 'ended' },
    }),
    ENV, db, callId,
  );
  assert.equal(ended.status, 201);
  const later = await handleAppendHumanCallEvent(
    makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-laptop', {
      clientEventId: 'event-late-1',
      generation: 0,
      kind: 'media',
      payload: { muted: true },
    }),
    ENV, db, callId,
  );
  assert.equal(later.status, 409);
});
