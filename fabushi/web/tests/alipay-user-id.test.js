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
                if (sql.includes('SELECT * FROM users WHERE alipay_user_id = ?')) {
                  return Array.from(state.userByUsername.values()).find((user) => (
                    user.alipay_user_id === params[0]
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
                if (sql.includes('SELECT * FROM users WHERE user_no = ?')) {
                  const expectedUserNo = Number(params[0]);
                  return Array.from(state.userByUsername.values()).find((user) => Number(user.user_no) === expectedUserNo) || null;
                }
                if (sql.includes('SELECT * FROM users WHERE username = ?')) {
                  return state.userByUsername.get(params[0]) || null;
                }
                return null;
              },
              async run() {
                if (sql.includes('INSERT INTO users')) {
                  const columns = sql
                    .match(/INSERT INTO users\s*\(([^)]+)\)/s)?.[1]
                    ?.split(',')
                    .map((column) => column.trim()) || [];
                  const row = Object.fromEntries(
                    columns.map((column, index) => [column, params[index]])
                  );
                  const username = row.username;
                  const email = row.email;
                  state.userByUsername.set(username, {
                    id: nextId++,
                    user_no: Number(row.user_no),
                    username,
                    email,
                    membership_type: row.membership_type,
                    membership_expires_at: row.membership_expires_at || null,
                    alipay_user_id: row.alipay_user_id,
                    alipay_nickname: row.alipay_nickname,
                    alipay_avatar: row.alipay_avatar,
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

test('one-click Alipay registration stores provider subject in mappings and token', async () => {
  const { env, state } = createDbEnv();
  const request = new Request('https://example.com/api/auth/alipay/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      oneClick: true,
      alipayProviderSubject: 'open_one_click',
      alipaySubjectType: 'open_id',
      alipayNickname: '支付宝用户'
    })
  });

  const response = await registerAlipayUser(request, env);
  const payload = await response.json();
  const tokenPayload = await verifyToken(payload.token, env);

  assert.equal(response.status, 200);
  assert.equal(payload.userId, 100);
  assert.equal(String(payload.userNo).length, 9);
  assert.equal(payload.user.userNo, payload.userNo);
  assert.equal(payload.alipayProviderSubject, 'open_one_click');
  assert.equal(state.emailMappings[0].userId, 100);
  assert.equal(state.alipayBindings[0].userId, 100);
  assert.equal(state.alipayBindings[0].alipayUserId, 'open_one_click');
  assert.equal(tokenPayload.userId, 100);
  assert.equal(tokenPayload.username, payload.username);
});

test('one-click Alipay registration reuses an existing user matched by provider subject', async () => {
  const { env, state } = createDbEnv();
  state.userByUsername.set('paid_user', {
    id: 77,
    user_no: 123456789,
    username: 'paid_user',
    email: 'paid@example.com',
    alipay_user_id: 'same_open_id',
    membership_type: 'paid',
    membership_expires_at: '2099-01-01T00:00:00.000Z',
  });

  const request = new Request('https://example.com/api/auth/alipay/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      oneClick: true,
      alipayProviderSubject: 'same_open_id',
      alipaySubjectType: 'open_id',
      alipayNickname: '支付宝用户'
    })
  });

  const response = await registerAlipayUser(request, env);
  const payload = await response.json();
  const tokenPayload = await verifyToken(payload.token, env);

  assert.equal(response.status, 200);
  assert.equal(payload.isNewUser, false);
  assert.equal(payload.userId, 77);
  assert.equal(payload.userNo, 123456789);
  assert.equal(payload.user.userNo, 123456789);
  assert.equal(payload.username, 'paid_user');
  assert.equal(tokenPayload.userId, 77);
  assert.equal(state.userByUsername.size, 1);
  assert.deepEqual(
    state.alipayBindings.map((binding) => binding.alipayUserId).sort(),
    ['same_open_id'],
  );
});

test('one-click Alipay registration migrates a legacy user_id match to open_id binding', async () => {
  const { env, state } = createDbEnv();
  state.userByUsername.set('legacy_user', {
    id: 88,
    user_no: 223344556,
    username: 'legacy_user',
    email: 'legacy@example.com',
    alipay_user_id: 'legacy_user_id',
    membership_type: 'paid',
    membership_expires_at: '2099-01-01T00:00:00.000Z',
  });

  const request = new Request('https://example.com/api/auth/alipay/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      oneClick: true,
      alipayProviderSubject: 'new_open_id',
      alipaySubjectType: 'open_id',
      alipayLegacyUserId: 'legacy_user_id',
      alipayNickname: '支付宝用户'
    })
  });

  const response = await registerAlipayUser(request, env);
  const payload = await response.json();
  const tokenPayload = await verifyToken(payload.token, env);

  assert.equal(response.status, 200);
  assert.equal(payload.isNewUser, false);
  assert.equal(payload.userId, 88);
  assert.equal(payload.alipayProviderSubject, 'new_open_id');
  assert.equal(tokenPayload.userId, 88);
  assert.equal(state.userByUsername.size, 1);
  assert.deepEqual(
    state.alipayBindings.map((binding) => binding.alipayUserId).sort(),
    ['new_open_id'],
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

test('manual Alipay registration stores provider subject in mappings and token', async () => {
  const { env, state } = createDbEnv();
  const request = new Request('https://example.com/api/auth/alipay/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'manual_user',
      email: 'manual@example.com',
      password: 'secure123',
      captcha: '1234',
      alipayProviderSubject: 'open_manual',
      alipaySubjectType: 'open_id',
      alipayNickname: '手动用户'
    })
  });

  const response = await registerAlipayUser(request, env);
  const payload = await response.json();
  const tokenPayload = await verifyToken(payload.token, env);

  assert.equal(response.status, 200);
  assert.equal(payload.userId, 100);
  assert.equal(String(payload.userNo).length, 9);
  assert.equal(payload.user.userNo, payload.userNo);
  assert.deepEqual(state.emailMappings[0], {
    email: 'manual@example.com',
    username: 'manual_user',
    userId: 100
  });
  assert.equal(state.alipayBindings[0].userId, 100);
  assert.equal(tokenPayload.userId, 100);
  assert.equal(tokenPayload.username, 'manual_user');
});

test('registration captcha flow stores provider subject in mappings and token', async () => {
  const { env, state } = createDbEnv();
  const request = new Request('https://example.com/api/auth/alipay/register-captcha', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'captcha_user',
      password: 'secure123',
      email: 'captcha@example.com',
      alipayProviderSubject: 'open_captcha',
      alipaySubjectType: 'open_id',
      nickname: '验证码用户'
    })
  });

  const response = await sendRegistrationCaptcha(request, env);
  const payload = await response.json();
  const tokenPayload = await verifyToken(payload.token, env);

  assert.equal(response.status, 201);
  assert.equal(payload.userId, 100);
  assert.equal(String(payload.userNo).length, 9);
  assert.equal(payload.user.userNo, payload.userNo);
  assert.deepEqual(state.emailMappings[0], {
    email: 'captcha@example.com',
    username: 'captcha_user',
    userId: 100
  });
  assert.equal(state.alipayBindings[0].userId, 100);
  assert.equal(tokenPayload.userId, 100);
  assert.equal(tokenPayload.username, 'captcha_user');
});
