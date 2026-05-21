import test from 'node:test';
import assert from 'node:assert/strict';

import { OnlineCounter } from '../src/durable-objects/OnlineCounter.js';

function createCounter() {
  const storage = {
    alarm: null,
    async getAlarm() {
      return this.alarm;
    },
    async setAlarm(value) {
      this.alarm = value;
    },
  };

  return new OnlineCounter({ storage }, {});
}

function jsonRequest(body) {
  return new Request('https://example.com/api/online', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('HTTP online joins and leaves broadcast counts to WebSocket clients', async () => {
  const counter = createCounter();
  const sentMessages = [];
  const ws = {
    send(message) {
      sentMessages.push(JSON.parse(message));
    },
  };

  counter.sessions.set('ws-session', {
    lastHeartbeat: Date.now(),
    ws,
  });
  counter.webSockets.set(ws, 'ws-session');

  const joinResponse = await counter.handleJoin(
    jsonRequest({ sessionId: 'http-session' }),
  );
  const joinPayload = await joinResponse.json();

  assert.equal(joinResponse.status, 200);
  assert.equal(joinPayload.count, 2);
  assert.equal(sentMessages[0].type, 'count_update');
  assert.equal(sentMessages[0].count, 2);

  const leaveResponse = await counter.handleLeave(
    jsonRequest({ sessionId: 'http-session' }),
  );
  const leavePayload = await leaveResponse.json();

  assert.equal(leaveResponse.status, 200);
  assert.equal(leavePayload.count, 1);
  assert.equal(sentMessages[1].type, 'count_update');
  assert.equal(sentMessages[1].count, 1);
});
