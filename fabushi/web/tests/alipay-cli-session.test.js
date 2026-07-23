import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleAlipayCliSession } from '../alipay-login-functions.js';

function environmentWith(stateData, changes = 1) {
  const calls = [];
  return {
    calls,
    env: {
      DB: {
        prepare(sql) {
          return {
            bind(...values) {
              calls.push({ sql, values });
              return {
                async first() {
                  return { state_data: JSON.stringify(stateData) };
                },
                async run() {
                  return { success: true, meta: { changes } };
                },
              };
            },
          };
        },
      },
    },
  };
}

test('CLI Alipay polling keeps a pending one-time state', async () => {
  const fixture = environmentWith({ type: 'cli', status: 'pending' });
  const response = await handleAlipayCliSession(
    new Request('https://api.example/api/auth/alipay/cli-session?state=random-state'),
    fixture.env,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { success: true, status: 'pending' });
  assert.equal(fixture.calls.length, 1);
});

test('CLI Alipay polling returns and deletes a completed token exactly once', async () => {
  const fixture = environmentWith({
    type: 'cli',
    status: 'complete',
    token: 'secret-token',
    username: 'tester',
    user: { id: 42, username: 'tester' },
  });
  const response = await handleAlipayCliSession(
    new Request('https://api.example/api/auth/alipay/cli-session?state=random-state'),
    fixture.env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.accessToken, 'secret-token');
  assert.equal(payload.token, undefined);
  assert.equal(payload.user.id, 42);
  assert.equal(fixture.calls.length, 2);
  assert.match(fixture.calls[1].sql, /DELETE FROM alipay_states/);
  assert.deepEqual(fixture.calls[1].values, [
    'random-state',
    JSON.stringify({
      type: 'cli',
      status: 'complete',
      token: 'secret-token',
      username: 'tester',
      user: { id: 42, username: 'tester' },
    }),
  ]);
});

test('CLI Alipay polling rejects a result consumed by a concurrent reader', async () => {
  const fixture = environmentWith(
    { type: 'cli', status: 'complete', token: 'secret-token' },
    0,
  );
  const response = await handleAlipayCliSession(
    new Request('https://api.example/api/auth/alipay/cli-session?state=random-state'),
    fixture.env,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: '登录结果已被读取' });
});

test('Alipay authorization marks CLI states as pending capabilities', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(root, 'alipay-login-functions.js'), 'utf8');
  assert.match(source, /platform === 'cli' \? 'cli' : callbackType/);
  assert.match(source, /status: 'pending'/);
  assert.match(source, /status: 'complete'/);
});

test('Alipay login logs do not expose one-time codes, signatures, or tokens', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(root, 'alipay-login-functions.js'), 'utf8');
  assert.doesNotMatch(source, /console\.log\('生成签名:',\s*sign\)/);
  assert.doesNotMatch(source, /console\.log\('支付宝access_token响应:',\s*result\)/);
  assert.doesNotMatch(source, /console\.log\('获取用户信息请求参数:',\s*params\)/);
  assert.doesNotMatch(source, /token\.substring\(/);
  assert.doesNotMatch(source, /fullUrl:\s*request\.url/);
  assert.doesNotMatch(source, /console\.log\('生成的授权URL:'/);
  assert.doesNotMatch(source, /console\.log\('响应数据:',\s*\{\s*authUrl/);
  assert.doesNotMatch(source, /console\.log\('授权字符串预览:'/);
  assert.doesNotMatch(source, /console\.log\('SDK授权登录，auth_code:'/);
  assert.doesNotMatch(source, /state\s*=\s*Math\.random\(/);
});
