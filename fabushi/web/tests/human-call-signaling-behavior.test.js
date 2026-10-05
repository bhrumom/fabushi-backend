import test from 'node:test';
import assert from 'node:assert/strict';
import { generateToken } from '../auth-utils.js';
import {
  handleAppendHumanCallEvent,
  handleCreateHumanCall,
  handleGetHumanCall,
  handleGetHumanCallIceServers,
  handleListHumanCalls,
} from '../src/handlers/call-signaling.js';

const ALICE = { id: 1, username: 'alice' };
const BOB = { id: 2, username: 'bob' };
const CAROL = { id: 3, username: 'carol' };

async function makeRequest(url, user, deviceId, body) {
  const token = await generateToken({ id: user.id, username: user.username }, ENV);
  return new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-fabushi-device-id': deviceId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function createDb({ failNextEventInsert = false } = {}) {
  const state = {
    users: [ALICE, BOB, CAROL],
    friends: new Set(['1:2', '2:1']),
    calls: new Map(),
    events: [],
    batchCalls: 0,
    lastChanges: 0,
    rollbackUpdateCalls: 0,
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
        if (q.includes('FROM human_call_channels') && q.includes('ORDER BY updated_at DESC')) {
          return {
            results: [...state.calls.values()]
              .filter((call) => call.creator_user_id === Number(params[0]) || call.peer_user_id === Number(params[1]))
              .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
              .slice(0, Number(params[2]))
              .map((call) => ({ ...call })),
          };
        }
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
            state: 'invited', generation: 0, event_seq: 0, terminal_state: null,
            created_at: createdAt, updated_at: updatedAt,
          });
          return { meta: { changes: 1 } };
        }
        if (q.startsWith('UPDATE human_call_channels SET state = ?') && q.includes('terminal_state = COALESCE')) {
          const [nextState, generation, eventSeq, terminalState, updatedAt, id, expectedState, expectedGeneration, expectedSeq] = params;
          const call = state.calls.get(id);
          if (!call || call.terminal_state || call.state !== expectedState
              || call.generation !== Number(expectedGeneration) || call.event_seq !== Number(expectedSeq)) {
            return { meta: { changes: 0 } };
          }
          call.state = nextState;
          call.generation = Number(generation);
          call.event_seq = Number(eventSeq);
          if (terminalState != null) call.terminal_state = terminalState;
          call.updated_at = updatedAt;
          return { meta: { changes: 1 } };
        }
        if (q.startsWith('UPDATE human_call_channels SET state = ?') && !q.includes('COALESCE')) {
          state.rollbackUpdateCalls += 1;
          const [oldState, generation, eventSeq, terminalState, updatedAt, id, expectedState, expectedGeneration, expectedSeq] = params;
          const call = state.calls.get(id);
          if (call && call.state === expectedState
              && call.generation === Number(expectedGeneration) && call.event_seq === Number(expectedSeq)) {
            call.state = oldState;
            call.generation = Number(generation);
            call.event_seq = Number(eventSeq);
            call.terminal_state = terminalState;
            call.updated_at = updatedAt;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (q.startsWith('INSERT INTO human_call_events')) {
          if (q.includes('WHERE changes() = 1') && state.lastChanges !== 1) {
            return { meta: { changes: 0 } };
          }
          if (failNextEventInsert) {
            failNextEventInsert = false;
            throw new Error('injected event insert failure');
          }
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
  const batch = async (statements) => {
    state.batchCalls += 1;
    const callsSnapshot = new Map(
      [...state.calls.entries()].map(([id, call]) => [id, { ...call }]),
    );
    const eventsSnapshot = state.events.map((event) => ({ ...event }));
    const previousLastChanges = state.lastChanges;
    try {
      const results = [];
      for (const statement of statements) {
        const result = await statement.run();
        state.lastChanges = Number(result.meta?.changes || 0);
        results.push(result);
      }
      return results;
    } catch (error) {
      state.calls.clear();
      for (const [id, call] of callsSnapshot.entries()) state.calls.set(id, call);
      state.events.splice(0, state.events.length, ...eventsSnapshot);
      state.lastChanges = previousLastChanges;
      throw error;
    }
  };
  return { state, prepare, batch };
}

const ENV = { JWT_SECRET: 'human-call-signaling-contract-secret-at-least-32-bytes-long' };

test('TURN credentials stay server-side and issue bounded authenticated ICE configuration', async () => {
  const db = createDb();
  let requestRecord = null;
  const fetchImpl = async (url, init) => {
    requestRecord = { url: String(url), init };
    return new Response(JSON.stringify({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turns:turn.cloudflare.com:443?transport=tcp',
          ],
          username: 'temporary-user',
          credential: 'temporary-credential',
        },
      ],
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const env = {
    ...ENV,
    FABUSHI_TURN_KEY_ID: 'turn-key-12345678',
    FABUSHI_TURN_KEY_API_TOKEN: 'server-only-turn-api-token',
    FABUSHI_TURN_CREDENTIAL_TTL_SECONDS: '7200',
  };
  const response = await handleGetHumanCallIceServers(
    await makeRequest('https://api.example.com/api/social/calls/ice', ALICE, 'alice-laptop'),
    env,
    db,
    fetchImpl,
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(payload.success, true);
  assert.equal(payload.ttlSeconds, 7200);
  assert.equal(payload.iceServers.length, 2);
  assert.equal(requestRecord.url,
    'https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-12345678/credentials/generate-ice-servers');
  assert.equal(requestRecord.init.method, 'POST');
  assert.equal(requestRecord.init.headers.Authorization, 'Bearer server-only-turn-api-token');
  assert.deepEqual(JSON.parse(requestRecord.init.body), { ttl: 7200 });
  assert.equal(JSON.stringify(payload).includes('server-only-turn-api-token'), false);
});

test('TURN endpoint fails closed when server credentials or upstream ICE data are invalid', async () => {
  const db = createDb();
  let fetchCalls = 0;
  const missing = await handleGetHumanCallIceServers(
    await makeRequest('https://api.example.com/api/social/calls/ice', ALICE, 'alice-laptop'),
    ENV,
    db,
    async () => { fetchCalls += 1; throw new Error('must not call'); },
  );
  assert.equal(missing.status, 503);
  assert.equal(fetchCalls, 0);

  const invalid = await handleGetHumanCallIceServers(
    await makeRequest('https://api.example.com/api/social/calls/ice', ALICE, 'alice-laptop'),
    {
      ...ENV,
      FABUSHI_TURN_KEY_ID: 'turn-key-12345678',
      FABUSHI_TURN_KEY_API_TOKEN: 'server-only-turn-api-token',
    },
    db,
    async () => new Response(JSON.stringify({ iceServers: [{ urls: 'https://not-ice.example' }] }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }),
  );
  assert.equal(invalid.status, 502);
});

test('call create is friend-scoped and stable across devices', async () => {
  const db = createDb();
  const callId = 'call-phase1-0001';
  const first = await handleCreateHumanCall(
    await makeRequest('https://api.example.com/api/social/calls', ALICE, 'alice-laptop', { callId, targetUserId: BOB.id }),
    ENV, db,
  );
  assert.equal(first.status, 201);
  const retry = await handleCreateHumanCall(
    await makeRequest('https://api.example.com/api/social/calls', ALICE, 'alice-phone', { callId, targetUserId: BOB.id }),
    ENV, db,
  );
  const retried = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retried.deduplicated, true);
  assert.equal(retried.call.state, 'invited');

  const incoming = await handleListHumanCalls(
    await makeRequest('https://api.example.com/api/social/calls?limit=20', BOB, 'bob-phone'),
    ENV, db,
  );
  const incomingPayload = await incoming.json();
  assert.equal(incoming.status, 200);
  assert.deepEqual(incomingPayload.calls.map((call) => call.callId), [callId]);

  const denied = await handleCreateHumanCall(
    await makeRequest('https://api.example.com/api/social/calls', ALICE, 'alice-laptop', { callId: 'call-phase1-0002', targetUserId: CAROL.id }),
    ENV, db,
  );
  assert.equal(denied.status, 403);
});

test('ordered events converge across participant devices with generation and idempotency fences', async () => {
  const db = createDb();
  const callId = 'call-phase1-1001';
  await handleCreateHumanCall(
    await makeRequest('https://api.example.com/api/social/calls', ALICE, 'alice-laptop', { callId, targetUserId: BOB.id }),
    ENV, db,
  );

  const accept = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, BOB, 'bob-phone', {
      clientEventId: 'event-accept-1',
      generation: 0,
      kind: 'transition',
      payload: { action: 'accept', state: 'negotiating' },
    }),
    ENV, db, callId,
  );
  assert.equal(accept.status, 201);
  const connected = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-laptop', {
      clientEventId: 'event-connected-1',
      generation: 0,
      kind: 'transition',
      payload: { action: 'connected', state: 'connected' },
    }),
    ENV, db, callId,
  );
  assert.equal(connected.status, 201);

  const signal = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-laptop', {
      clientEventId: 'event-offer-1',
      generation: 0,
      kind: 'signal',
      payload: { type: 'offer', sdp: 'opaque-offer' },
    }),
    ENV, db, callId,
  );
  const signalPayload = await signal.json();
  assert.equal(signal.status, 201);
  assert.equal(signalPayload.event.seq, 3);

  const replay = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-laptop', {
      clientEventId: 'event-offer-1',
      generation: 0,
      kind: 'signal',
      payload: { type: 'offer', sdp: 'opaque-offer' },
    }),
    ENV, db, callId,
  );
  assert.equal((await replay.json()).deduplicated, true);

  const conflict = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-laptop', {
      clientEventId: 'event-offer-1',
      generation: 0,
      kind: 'signal',
      payload: { type: 'offer', sdp: 'different' },
    }),
    ENV, db, callId,
  );
  assert.equal(conflict.status, 409);

  const reconnect = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-phone', {
      clientEventId: 'event-reconnect-1',
      generation: 1,
      kind: 'transition',
      payload: { action: 'reconnect', state: 'reconnecting' },
    }),
    ENV, db, callId,
  );
  assert.equal(reconnect.status, 201);

  const stale = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, BOB, 'bob-phone', {
      clientEventId: 'event-answer-stale',
      generation: 0,
      kind: 'signal',
      payload: { type: 'answer' },
    }),
    ENV, db, callId,
  );
  assert.equal(stale.status, 409);

  const peer = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, BOB, 'bob-phone', {
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
      await makeRequest(`https://api.example.com/api/social/calls/${callId}?afterSeq=3&limit=50`, ALICE, deviceId),
      ENV, db, callId,
    );
    const payload = await synced.json();
    assert.equal(synced.status, 200);
    assert.deepEqual(payload.events.map((event) => event.seq), [4, 5]);
    assert.equal(payload.call.generation, 1);
  }

  const outsider = await handleGetHumanCall(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}`, CAROL, 'carol-phone'),
    ENV, db, callId,
  );
  assert.equal(outsider.status, 404);
});

test('terminal transition fences later mutations', async () => {
  const db = createDb();
  const callId = 'call-phase1-2001';
  await handleCreateHumanCall(
    await makeRequest('https://api.example.com/api/social/calls', ALICE, 'alice-laptop', { callId, targetUserId: BOB.id }),
    ENV, db,
  );
  const ended = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, BOB, 'bob-phone', {
      clientEventId: 'event-end-1',
      generation: 0,
      kind: 'transition',
      payload: { action: 'hangup', state: 'ended' },
    }),
    ENV, db, callId,
  );
  assert.equal(ended.status, 201);
  const later = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-laptop', {
      clientEventId: 'event-late-1',
      generation: 0,
      kind: 'media',
      payload: { muted: true },
    }),
    ENV, db, callId,
  );
  assert.equal(later.status, 409);
});


test('call channel CAS and event append commit atomically in one D1 batch', async () => {
  const db = createDb({ failNextEventInsert: true });
  const callId = 'call-phase1-atomic-0001';
  await handleCreateHumanCall(
    await makeRequest('https://api.example.com/api/social/calls', ALICE, 'alice-laptop', {
      callId,
      targetUserId: BOB.id,
    }),
    ENV, db,
  );
  const before = { ...db.state.calls.get(callId) };

  const failed = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-laptop', {
      clientEventId: 'event-ring-atomic-1',
      generation: 0,
      kind: 'transition',
      payload: { action: 'ring', state: 'ringing' },
    }),
    ENV, db, callId,
  );
  assert.equal(failed.status, 409);
  assert.deepEqual(db.state.calls.get(callId), before);
  assert.equal(db.state.events.length, 0);
  assert.equal(db.state.batchCalls, 1);
  assert.equal(db.state.rollbackUpdateCalls, 0);

  const retried = await handleAppendHumanCallEvent(
    await makeRequest(`https://api.example.com/api/social/calls/${callId}/events`, ALICE, 'alice-laptop', {
      clientEventId: 'event-ring-atomic-1',
      generation: 0,
      kind: 'transition',
      payload: { action: 'ring', state: 'ringing' },
    }),
    ENV, db, callId,
  );
  assert.equal(retried.status, 201);
  assert.equal(db.state.calls.get(callId).state, 'ringing');
  assert.equal(db.state.calls.get(callId).event_seq, 1);
  assert.equal(db.state.events.length, 1);
  assert.equal(db.state.batchCalls, 2);
  assert.equal(db.state.rollbackUpdateCalls, 0);
});
