import test from 'node:test';
import assert from 'node:assert/strict';

import { generateAlipayLoginUrl, registerAlipayUser, sendRegistrationCaptcha } from '../alipay-login-functions.js';
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
                if (sql.includes('SELECT * FROM users WHERE alipay_user_id = ? OR alipay_open_id = ?')) {
                  return Array.from(state.userByUsername.values()).find((user) => (
                    user.alipay_user_id === params[0] || user.alipay_open_id === params[1]
                  )) || null;
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
                  const hasMembershipExpiry = sql.includes('membership_expires_at');
                  const alipayUserIdIndex = hasMembershipExpiry ? 9 : 8;
                  const alipayOpenIdIndex = hasMembershipExpiry ? 10 : 9;
                  state.userByUsername.set(username, {
                    id: nextId++,
                    username,
                    email,
                    membership_type: params[7],
                    membership_expires_at: hasMembershipExpiry ? params[8] : null,
                    alipay_user_id: params[alipayUserIdIndex],
                    alipay_open_id: params[alipayOpenIdIndex],
                  });
                } else if (sql.includes('INSERT INTO email_username_mapping')) {
                  state.emailMappings.push({ email: params[0], username: params[1], userId: params[2] });
                } else if (sql.includes('INSERT OR REPLACE INTO alipay_bindings') || sql.includes('INSERT INTO alipay_bindings')) {
                  state.alipayBindings = state.alipayBindings.filter((item) => item.alipayUserId !== params[0]);
                  state.alipayBindings.push({ alipayUserId: params[0], username: params[1], userId: params[2], boundAt: params[3] });
                } else if (sql.includes('UPDATE users SET') && sql.includes('WHERE id = ?')) {
                  const fields = sql
                    .match(/UPDATE users SET\s+(.+), updated_at = \? WHERE id = \?/s)?.[1]
                    ?.split(',')
                    .map((field) => field.trim().split(' = ')[0])
                    .filter(Boolean) || [];
                  const userId = params[fields.length + 1];
                  const user = Array.from(state.userByUsername.values()).find((item) => item.id === Number(userId));
                  if (user) {
                    for (const [index, field] of fields.entries()) {
                      user[field] = params[index];
                    }
                  }
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

test('one-click Alipay registration reuses an existing user matched by open_id', async () => {
  const { env, state } = createDbEnv();
  state.userByUsername.set('paid_user', {
    id: 77,
    username: 'paid_user',
    email: 'paid@example.com',
    alipay_open_id: 'open_same_account',
    membership_type: 'paid',
    membership_expires_at: '2099-01-01T00:00:00.000Z',
  });

  const request = new Request('https://example.com/api/auth/alipay/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      oneClick: true,
      alipayUserId: 'desktop_user_id',
      alipayOpenId: 'open_same_account',
      alipayNickname: '支付宝用户'
    })
  });

  const response = await registerAlipayUser(request, env);
  const payload = await response.json();
  const tokenPayload = await verifyToken(payload.token, env);

  assert.equal(response.status, 200);
  assert.equal(payload.isNewUser, false);
  assert.equal(payload.userId, 77);
  assert.equal(payload.username, 'paid_user');
  assert.equal(tokenPayload.userId, 77);
  assert.equal(state.userByUsername.size, 1);
  assert.deepEqual(
    state.alipayBindings.map((binding) => binding.alipayUserId).sort(),
    ['desktop_user_id', 'open_same_account'],
  );
});

test('mobile Alipay OAuth URL uses the backend callback directly', async () => {
  for (const platform of ['android', 'ios']) {
    const { env } = createDbEnv();
    env.ALIPAY_APP_ID = 'test-app-id';
    env.WORKER_URL = 'https://api.ombhrum.com';

    const response = await generateAlipayLoginUrl(env, platform);
    const payload = await response.json();
    const authUrl = new URL(payload.authUrl);

    assert.equal(response.status, 200);
    assert.equal(payload.platform, 'mobile');
    assert.equal(
      authUrl.searchParams.get('redirect_uri'),
      'https://api.ombhrum.com/api/auth/alipay/callback',
    );
  }
});

test('mobile Alipay OAuth URL honors explicit redirect override', async () => {
  const { env } = createDbEnv();
  env.ALIPAY_APP_ID = 'test-app-id';
  env.WORKER_URL = 'https://api.ombhrum.com';
  env.ALIPAY_MOBILE_AUTH_REDIRECT_URL = 'https://example.com/alipay-callback';

  const response = await generateAlipayLoginUrl(env, 'android');
  const payload = await response.json();
  const authUrl = new URL(payload.authUrl);

  assert.equal(response.status, 200);
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://example.com/alipay-callback');
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
