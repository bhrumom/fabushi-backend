import assert from 'node:assert/strict';
import test from 'node:test';

import { hasUnlimitedUsage, isAdminUser } from '../src/utils/helpers.js';

test('bhrum108 is always a super administrator by username', () => {
  const user = { username: 'bhrum108', email: 'not-listed@example.com' };
  assert.equal(isAdminUser(user, {}), true);
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
