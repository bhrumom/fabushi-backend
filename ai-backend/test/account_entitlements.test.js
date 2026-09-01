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

test('bhrum108 keeps super-admin entitlement when only stable account id is available', () => {
  assert.deepEqual(resolveAccountEntitlements({ id: 22 }, {}), {
    role: 'super_admin',
    isAdmin: true,
    unlimitedUsage: true,
  });
  assert.equal(hasUnlimitedUsage({ userId: '22' }, {}), true);
});

test('ordinary accounts are not implicitly privileged', () => {
  assert.deepEqual(resolveAccountEntitlements({ username: 'ordinary-user' }, {}), {
    role: 'user',
    isAdmin: false,
    unlimitedUsage: false,
  });
});

test('dedicated Fabushi MCP CI account has unlimited usage without admin access', () => {
  assert.deepEqual(resolveAccountEntitlements({ username: 'fabushi_mcp_ci_test' }, {}), {
    role: 'user',
    isAdmin: false,
    unlimitedUsage: true,
  });
  assert.equal(hasUnlimitedUsage({ id: 197915874789377 }, {}), true);
});

test('additional super admins may be configured without removing bhrum108', () => {
  const env = { SUPER_ADMIN_USERNAMES: 'ops-admin', SUPER_ADMIN_ACCOUNT_IDS: '73' };
  assert.equal(hasUnlimitedUsage({ username: 'ops-admin' }, env), true);
  assert.equal(hasUnlimitedUsage({ id: 73 }, env), true);
  assert.equal(hasUnlimitedUsage({ username: 'bhrum108' }, env), true);
  assert.equal(hasUnlimitedUsage({ id: 22 }, env), true);
});
