import test from 'node:test';
import assert from 'node:assert/strict';

import { isDachengAiPath } from '../src/handlers/dacheng-ai.js';

test('Dacheng AI proxy includes first-party agent endpoints', () => {
  assert.equal(isDachengAiPath('/api/agent/chat'), true);
  assert.equal(isDachengAiPath('/api/agent/runs/run_1/events'), true);
  assert.equal(isDachengAiPath('/api/agent/runs/run_1/cancel'), true);
  assert.equal(isDachengAiPath('/api/agent/messages/msg_1/feedback'), true);
});

test('Dacheng AI proxy still rejects unrelated API endpoints', () => {
  assert.equal(isDachengAiPath('/api/auth/login'), false);
});
