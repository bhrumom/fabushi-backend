import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUP_NO_LENGTH,
  USER_NO_LENGTH,
  generateExternalNumericNo,
  generateGroupNo,
  generateUserNo,
} from '../src/services/external-numbers.js';

test('external numeric numbers use fixed non-enumerable display lengths', () => {
  const userNo = generateUserNo();
  const groupNo = generateGroupNo();

  assert.match(String(userNo), /^\d{9}$/);
  assert.match(String(groupNo), /^\d{8}$/);
  assert.equal(USER_NO_LENGTH, 9);
  assert.equal(GROUP_NO_LENGTH, 8);
});

test('external numeric generator rejects unsafe display lengths', () => {
  assert.throws(() => generateExternalNumericNo(1), /between 2 and 9/);
  assert.throws(() => generateExternalNumericNo(10), /between 2 and 9/);
});
