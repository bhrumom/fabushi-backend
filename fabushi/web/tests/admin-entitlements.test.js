import assert from 'node:assert/strict';
import test from 'node:test';

import { hasUnlimitedUsage, isAdminUser } from '../src/utils/helpers.js';

test('bhrum108 is always a super administrator by username', () => {
  const user = { username: 'bhrum108', email: 'not-listed@example.com' };
  assert.equal(isAdminUser(user, {}), true);
  assert.equal(hasUnlimitedUsage(user, {}), true);
});

test('bhrum108 is recognized by stable account id when profile names are absent', () => {
  const user = { id: 22, email: '' };
  assert.equal(isAdminUser(user, {}), true);
  assert.equal(hasUnlimitedUsage(user, {}), true);
});

test('dedicated Fabushi MCP CI account has unlimited usage without admin access', () => {
  const user = { username: 'fabushi_mcp_ci_test', email: '' };
  assert.equal(isAdminUser(user, {}), false);
  assert.equal(hasUnlimitedUsage(user, {}), true);
});

test('configured email admins keep admin access but do not gain unlimited quota', () => {
  const env = { ADMIN_EMAILS: 'ops@example.com' };
  const user = { username: 'ops', email: 'ops@example.com' };
  assert.equal(isAdminUser(user, env), true);
  assert.equal(hasUnlimitedUsage(user, env), false);
});

test('configured admin usernames gain the same super-admin entitlement', () => {
  const env = { ADMIN_USERNAMES: 'release-admin' };
  const user = { username: 'release-admin', email: 'release@example.com' };
  assert.equal(isAdminUser(user, env), true);
  assert.equal(hasUnlimitedUsage(user, env), true);
});

test('configured stable account ids gain the same super-admin entitlement', () => {
  const env = { SUPER_ADMIN_ACCOUNT_IDS: '73' };
  const user = { userId: '73', email: '' };
  assert.equal(isAdminUser(user, env), true);
  assert.equal(hasUnlimitedUsage(user, env), true);
});
