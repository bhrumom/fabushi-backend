import test from 'node:test';
import assert from 'node:assert/strict';

import { registerAlipayUser, sendRegistrationCaptcha } from '../alipay-login-functions.js';
import { verifyToken } from '../auth-utils.js';

function createDbEnv() {
  const state = {
    userByUsername: new Map(),
    emailMappings: [],
    alipayBindings: []
  };
  let nextId = 100;

  const env = {
    JWT_SECRET: 'test-secret',
    DB: {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              async first() {
                if (sql.includes('SELECT user_id, username FROM alipay_bindings WHERE alipay_user_id = ?')) {
                  const record = state.alipayBindings.find((item) => item.alipayUserId === params[0]);
                  return record ? { user_id: record.userId, username: record.username } : null;
                }
                if (sql.includes('SELECT user_id, username FROM email_username_mapping WHERE email = ?')) {
                  const record = state.emailMappings.find((item) => item.email === params[0]);
                  return record ? { user_id: record.userId, username: record.username } : null;
                }
                if (sql.includes('SELECT username FROM users WHERE username = ?')) {
                  const user = state.userByUsername.get(params[0]);
                  return user ? { username: user.username } : null;
                }
                if (sql.includes('SELECT id, username, email FROM users WHERE username = ?')) {
                  return state.userByUsername.get(params[0]) || null;
                }
                if (sql.includes('SELECT * FROM users WHERE id = ?')) {
                  return Array.from(state.userByUsername.values()).find((user) => user.id === Number(params[0])) || null;
                }
                if (sql.includes('SELECT * FROM users WHERE username = ?')) {
                  return state.userByUsername.get(params[0]) || null;
                }
                return null;
              },
              async run() {
                if (sql.includes('INSERT INTO users')) {
                  const username = params[0];
                  const email = params[1];
                  state.userByUsername.set(username, { id: nextId++, username, email });
                } else if (sql.includes('INSERT INTO email_username_mapping')) {
                  state.emailMappings.push({ email: params[0], username: params[1], userId: params[2] });
                } else if (sql.includes('INSERT OR REPLACE INTO alipay_bindings') || sql.includes('INSERT INTO alipay_bindings')) {
                  state.alipayBindings = state.alipayBindings.filter((item) => item.alipayUserId !== params[0]);
                  state.alipayBindings.push({ alipayUserId: params[0], username: params[1], userId: params[2], boundAt: params[3] });
                }
                return { success: true };
              }
            };
          }
        };
      }
    }
  };

  return { env, state };
}

test('one-click Alipay registration stores user_id in mappings and token', async () => {
  const { env, state } = createDbEnv();
  const request = new Request('https://example.com/api/auth/alipay/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      oneClick: true,
      alipayUserId: 'ali_one_click',
      alipayNickname: '支付宝用户'
    })
  });

  const response = await registerAlipayUser(request, env);
  const payload = await response.json();
  const tokenPayload = await verifyToken(payload.token, env);

  assert.equal(response.status, 200);
  assert.equal(payload.userId, 100);
  assert.equal(state.emailMappings[0].userId, 100);
  assert.equal(state.alipayBindings[0].userId, 100);
  assert.equal(tokenPayload.userId, 100);
  assert.equal(tokenPayload.username, payload.username);
});

test('manual Alipay registration stores user_id in mappings and token', async () => {
  const { env, state } = createDbEnv();
  const request = new Request('https://example.com/api/auth/alipay/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'manual_user',
      email: 'manual@example.com',
      password: 'secure123',
      captcha: '1234',
      alipayUserId: 'ali_manual',
      alipayNickname: '手动用户'
    })
  });

  const response = await registerAlipayUser(request, env);
  const payload = await response.json();
  const tokenPayload = await verifyToken(payload.token, env);

  assert.equal(response.status, 200);
  assert.equal(payload.userId, 100);
  assert.deepEqual(state.emailMappings[0], {
    email: 'manual@example.com',
    username: 'manual_user',
    userId: 100
  });
  assert.equal(state.alipayBindings[0].userId, 100);
  assert.equal(tokenPayload.userId, 100);
  assert.equal(tokenPayload.username, 'manual_user');
});

test('registration captcha flow stores user_id in mappings and token', async () => {
  const { env, state } = createDbEnv();
  const request = new Request('https://example.com/api/auth/alipay/register-captcha', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'captcha_user',
      password: 'secure123',
      email: 'captcha@example.com',
      alipayUserId: 'ali_captcha',
      nickname: '验证码用户'
    })
  });

  const response = await sendRegistrationCaptcha(request, env);
  const payload = await response.json();
  const tokenPayload = await verifyToken(payload.token, env);

  assert.equal(response.status, 201);
  assert.equal(payload.userId, 100);
  assert.deepEqual(state.emailMappings[0], {
    email: 'captcha@example.com',
    username: 'captcha_user',
    userId: 100
  });
  assert.equal(state.alipayBindings[0].userId, 100);
  assert.equal(tokenPayload.userId, 100);
  assert.equal(tokenPayload.username, 'captcha_user');
});
