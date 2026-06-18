import assert from 'node:assert/strict';
import test from 'node:test';

import { generateToken } from '../auth-utils.js';
import { handleCheckAlipayMembership } from '../src/handlers/membership.js';

const env = { JWT_SECRET: 'membership-user-id-test-secret' };

test('Alipay membership status resolves stale token username through userId', async () => {
  const token = await generateToken({ id: 88, username: 'stale_desktop_name' }, env);
  let usernameFallbackUsed = false;
  const db = {
    async getUserById(userId) {
      assert.equal(userId, 88);
      return {
        id: 88,
        user_no: 812091331,
        username: 'real_paid_user',
        email: 'real@example.com',
        membership_type: 'paid',
        membership_expires_at: '2099-06-30T00:00:00.000Z',
      };
    },
    async getUser() {
      usernameFallbackUsed = true;
      return null;
    },
  };

  const response = await handleCheckAlipayMembership(
    new Request('https://example.com/api/membership/alipay/status', {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    db,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(usernameFallbackUsed, false);
  assert.equal(body.username, 'real_paid_user');
  assert.equal(body.userId, 88);
  assert.equal(body.userNo, 812091331);
  assert.equal(body.membership.type, 'paid');
  assert.equal(body.membership.isActive, true);
});
