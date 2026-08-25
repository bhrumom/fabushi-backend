import assert from 'node:assert/strict';
import test from 'node:test';

import { hasUnlimitedUsage, resolveAccountEntitlements } from '../src/account_entitlements.js';

test('bhrum108 is a built-in super admin with unlimited usage', () => {
  assert.deepEqual(resolveAccountEntitlements({ username: 'bhrum108' }, {}), {
    role: 'super_admin',
    isAdmin: true,
    unlimitedUsage: true,
  });
  assert.equal(hasUnlimitedUsage({ username: 'BHRUM108' }, {}), true);
});

test('ordinary accounts are not implicitly privileged', () => {
  assert.deepEqual(resolveAccountEntitlements({ username: 'ordinary-user' }, {}), {
    role: 'user',
    isAdmin: false,
    unlimitedUsage: false,
  });
});

test('additional super admins may be configured without removing bhrum108', () => {
  const env = { SUPER_ADMIN_USERNAMES: 'ops-admin' };
  assert.equal(hasUnlimitedUsage({ username: 'ops-admin' }, env), true);
  assert.equal(hasUnlimitedUsage({ username: 'bhrum108' }, env), true);
});
