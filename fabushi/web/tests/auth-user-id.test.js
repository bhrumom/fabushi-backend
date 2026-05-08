import test from 'node:test';
import assert from 'node:assert/strict';

import { createPasswordHash, generateToken, verifyToken } from '../auth-utils.js';
import { handlePasswordLogin } from '../src/handlers/password-login.js';
import { handleGetUserInfo } from '../src/handlers/auth.js';

function createDb(user) {
  return {
    async getUser(username) {
      return username === user.username ? { ...user } : null;
    },
    async getUserById(id) {
      return Number(id) === user.id ? { ...user } : null;
    },
    async getUserByEmail(email) {
      return email === user.email ? { ...user } : null;
    },
    async getUserByPhone(phone) {
      return phone === user.phone_number ? { ...user } : null;
    }
  };
}

test('new token keeps userId and old token remains compatible', async () => {
  const env = { JWT_SECRET: 'test-secret' };
  const newToken = await generateToken({ id: 42, username: 'stable_user' }, env);
  const oldToken = await generateToken('legacy_user', env);

  const newPayload = await verifyToken(newToken, env);
  const oldPayload = await verifyToken(oldToken, env);

  assert.equal(newPayload.userId, 42);
  assert.equal(newPayload.username, 'stable_user');
  assert.equal(oldPayload.userId, undefined);
  assert.equal(oldPayload.username, 'legacy_user');
});

test('password login issues userId-first token and returns userId', async () => {
  const env = { JWT_SECRET: 'test-secret' };
  const creds = await createPasswordHash('correct-password');
  const user = {
    id: 7,
    username: 'login_user',
    email: 'login@example.com',
    phone_number: '+8613800138555',
    password_hash: creds.passwordHash,
    salt: creds.salt,
    iterations: creds.iterations,
    algo: creds.algo,
    nickname: '登录用户',
    email_verified: 1,
    membership_type: 'trial',
    free_trial_end_date: '2026-06-01T00:00:00Z',
    created_at: '2026-05-01T00:00:00Z'
  };

  const db = createDb(user);
  const request = new Request('https://example.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.email, password: 'correct-password' })
  });

  const response = await handlePasswordLogin(request, env, {
    ...db,
    async getUserByEmail() { return { ...user }; }
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.userId, 7);
  const tokenPayload = await verifyToken(payload.token, env);
  assert.equal(tokenPayload.userId, 7);
  assert.equal(tokenPayload.username, 'login_user');
});

test('auth handler prefers token userId over mismatched username', async () => {
  const env = { JWT_SECRET: 'test-secret' };
  const user = {
    id: 9,
    username: 'right_user',
    email: 'right@example.com',
    nickname: '正确用户',
    phone_number: null,
    email_verified: 1,
    membership_type: 'trial',
    free_trial_end_date: '2026-06-01T00:00:00Z',
    created_at: '2026-05-01T00:00:00Z'
  };
  const db = createDb(user);
  const token = await generateToken({ id: 9, username: 'wrong_user' }, env);
  const request = new Request('https://example.com/api/auth/user-info', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const response = await handleGetUserInfo(request, env, db);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.userId, 9);
  assert.equal(payload.username, 'right_user');
});
