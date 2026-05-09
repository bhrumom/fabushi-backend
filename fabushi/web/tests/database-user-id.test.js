import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSnowflakeUserIdState,
  generateSnowflakeUserId,
  normalizeSnowflakeWorkerId,
  USER_ID_CUSTOM_EPOCH_MS,
  USER_ID_MAX_SEQUENCE,
} from '../src/services/database.js';

test('snowflake user ids stay monotonic and within safe integer range', () => {
  const nowMs = USER_ID_CUSTOM_EPOCH_MS + 123456789;
  const state = createSnowflakeUserIdState(3);

  const ids = [
    generateSnowflakeUserId({ nowMs, workerId: 3, state }),
    generateSnowflakeUserId({ nowMs, workerId: 3, state }),
    generateSnowflakeUserId({ nowMs, workerId: 3, state }),
  ];

  assert.equal(ids.length, new Set(ids).size);
  assert.ok(ids[0] < ids[1]);
  assert.ok(ids[1] < ids[2]);
  for (const id of ids) {
    assert.equal(Number.isSafeInteger(id), true);
    assert.ok(id > 0);
    assert.ok(String(id).length > 6);
  }
});

test('snowflake user ids roll forward after one-millisecond sequence is exhausted', () => {
  const nowMs = USER_ID_CUSTOM_EPOCH_MS + 22334455;
  const state = createSnowflakeUserIdState(1);
  const ids = Array.from({ length: USER_ID_MAX_SEQUENCE + 2 }, () =>
    generateSnowflakeUserId({ nowMs, workerId: 1, state })
  );

  assert.equal(ids.length, new Set(ids).size);
  assert.ok(ids.at(-2) < ids.at(-1));
  assert.ok(ids.at(-1) - ids[0] > USER_ID_MAX_SEQUENCE);
});

test('snowflake worker id normalization keeps ids deterministic', () => {
  const nowMs = USER_ID_CUSTOM_EPOCH_MS + 99887766;
  const workerId = normalizeSnowflakeWorkerId(65);
  const state = createSnowflakeUserIdState(workerId);
  const id = generateSnowflakeUserId({ nowMs, workerId: 65, state });

  assert.equal(workerId, 1);
  assert.equal(Number.isSafeInteger(id), true);
});
