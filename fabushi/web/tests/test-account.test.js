import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGetUserInfo } from '../src/handlers/auth.js';
import { isDachengAiPath } from '../src/handlers/dacheng-ai.js';
import {
  handleCheckAlipayMembership,
  handleCheckMembershipStatus,
} from '../src/handlers/membership.js';
import { isTestAccountRequest } from '../src/utils/test-account.js';

const testToken = 'test-account-token-with-at-least-thirty-two-characters';

test('fixed test account token is compared without entering the normal JWT repository flow', async () => {
  const env = { TEST_ACCOUNT_TOKEN: testToken };
  const request = new Request('https://api.example/api/auth/user-info', {
    headers: { Authorization: `Bearer ${testToken}` },
  });
  assert.equal(await isTestAccountRequest(request, env), true);

  const response = await handleGetUserInfo(request, env, {
    getUser() { throw new Error('normal account repository must not be used'); },
  });
  assert.equal(response.status, 200);
  const account = await response.json();
  assert.equal(account.userId, 'user:test_account');
  assert.equal(account.username, 'TestAccount');
  assert.equal(account.isTestAccount, true);
  assert.equal(account.membership.type, 'lifetime');
});

test('wrong or missing test tokens are rejected by the fixed-account matcher', async () => {
  const env = { TEST_ACCOUNT_TOKEN: testToken };
  assert.equal(await isTestAccountRequest(new Request('https://api.example'), env), false);
  assert.equal(await isTestAccountRequest(new Request('https://api.example', {
    headers: { Authorization: 'Bearer wrong-token-with-at-least-thirty-two-characters' },
  }), env), false);
});

test('authoritative usage path is proxied to the AI backend', () => {
  assert.equal(isDachengAiPath('/v1/ai/usage'), true);
});

test('test account is lifetime-active on both membership compatibility endpoints', async () => {
  const env = { TEST_ACCOUNT_TOKEN: testToken };
  const db = {
    getUser() { throw new Error('test account must not query normal users'); },
    getUserById() { throw new Error('test account must not query normal users'); },
  };
  for (const handler of [handleCheckMembershipStatus, handleCheckAlipayMembership]) {
    const response = await handler(new Request('https://api.example/membership', {
      headers: { Authorization: `Bearer ${testToken}` },
    }), env, db);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.userId, 'user:test_account');
    assert.equal(payload.isTestAccount, true);
    assert.equal(payload.membership.type, 'lifetime');
    assert.equal(payload.membership.isActive, true);
  }
});
