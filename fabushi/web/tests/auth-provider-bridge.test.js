import assert from 'node:assert/strict';
import { handleAuthProviderBridgeRequest, isFabushiBrowserAlipayState } from '../src/handlers/auth-provider-bridge.js';

assert.equal(isFabushiBrowserAlipayState(`fbs_${'a'.repeat(32)}`), true);
assert.equal(isFabushiBrowserAlipayState('legacy-state'), false);

const baseEnv = {
  AUTH_PROVIDER_BRIDGE_SECRET: 'x'.repeat(48),
  ALIPAY_APP_ID: '2021000000000000',
  ALIPAY_PRIVATE_KEY: 'private',
  ALIPAY_PUBLIC_KEY: 'public',
  ALIPAY_MOBILE_AUTH_REDIRECT_URL: 'https://legacy.example/api/auth/alipay/callback',
};

const unauthorized = await handleAuthProviderBridgeRequest({
  pathname: '/api/internal/auth-provider/capabilities',
  method: 'GET',
  request: new Request('https://legacy.example/api/internal/auth-provider/capabilities'),
  env: baseEnv,
});
assert.equal(unauthorized.status, 403);

const headers = { 'X-Fabushi-Auth-Bridge': baseEnv.AUTH_PROVIDER_BRIDGE_SECRET };
const authorized = await handleAuthProviderBridgeRequest({
  pathname: '/api/internal/auth-provider/capabilities',
  method: 'GET',
  request: new Request('https://legacy.example/api/internal/auth-provider/capabilities', { headers }),
  env: baseEnv,
});
assert.equal(authorized.status, 200);
assert.deepEqual(await authorized.json(), { ok: true, alipay: true, email: false });

const incompleteEmailEnv = {
  ...baseEnv,
  AUTH_SYSTEM_MAIL_URL: 'https://ai.ombhrum.com/internal/fabushi-mail/v1/send',
};
const incompleteEmailCapabilities = await handleAuthProviderBridgeRequest({
  pathname: '/api/internal/auth-provider/capabilities',
  method: 'GET',
  request: new Request('https://legacy.example/api/internal/auth-provider/capabilities', { headers }),
  env: incompleteEmailEnv,
});
assert.deepEqual(await incompleteEmailCapabilities.json(), { ok: true, alipay: true, email: false });

const disabledEmailEnv = {
  ...incompleteEmailEnv,
  AUTH_SYSTEM_MAIL_TOKEN: 'm'.repeat(64),
};
const disabledEmailCapabilities = await handleAuthProviderBridgeRequest({
  pathname: '/api/internal/auth-provider/capabilities',
  method: 'GET',
  request: new Request('https://legacy.example/api/internal/auth-provider/capabilities', { headers }),
  env: disabledEmailEnv,
});
assert.deepEqual(await disabledEmailCapabilities.json(), { ok: true, alipay: true, email: false });

const emailEnv = {
  ...disabledEmailEnv,
  AUTH_SYSTEM_MAIL_ENABLED: 'true',
};
const emailCapabilities = await handleAuthProviderBridgeRequest({
  pathname: '/api/internal/auth-provider/capabilities',
  method: 'GET',
  request: new Request('https://legacy.example/api/internal/auth-provider/capabilities', { headers }),
  env: emailEnv,
});
assert.deepEqual(await emailCapabilities.json(), { ok: true, alipay: true, email: true });

const originalFetch = globalThis.fetch;
let mailRequest = null;
globalThis.fetch = async (url, init) => {
  mailRequest = { url: String(url), init };
  return new Response(JSON.stringify({ ok: true, provider: 'bhrum2-postfix' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
const emailResponse = await handleAuthProviderBridgeRequest({
  pathname: '/api/internal/auth-provider/email/send-registration-code',
  method: 'POST',
  request: new Request('https://legacy.example/api/internal/auth-provider/email/send-registration-code', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com', code: '123456' }),
  }),
  env: emailEnv,
});
assert.equal(emailResponse.status, 200);
assert.equal((await emailResponse.json()).provider, 'bhrum2-postfix');
assert.equal(mailRequest.url, emailEnv.AUTH_SYSTEM_MAIL_URL);
assert.equal(mailRequest.init.headers.Authorization, `Bearer ${emailEnv.AUTH_SYSTEM_MAIL_TOKEN}`);
assert.deepEqual(JSON.parse(mailRequest.init.body), {
  email: 'user@example.com',
  subject: 'Fabushi 注册验证码',
  text: '你的 Fabushi 注册验证码是：123456\n\n验证码 10 分钟内有效。如果不是你本人操作，请忽略这封邮件。',
});
globalThis.fetch = originalFetch;

const state = `fbs_${'b'.repeat(32)}`;
const redirect = await handleAuthProviderBridgeRequest({
  pathname: '/api/internal/auth-provider/alipay/authorize',
  method: 'GET',
  request: new Request(`https://legacy.example/api/internal/auth-provider/alipay/authorize?state=${state}`),
  env: baseEnv,
});
assert.equal(redirect.status, 302);
const location = new URL(redirect.headers.get('location'));
assert.equal(location.origin + location.pathname, 'https://openauth.alipay.com/oauth2/publicAppAuthorize.htm');
assert.equal(location.searchParams.get('state'), state);
assert.equal(location.searchParams.get('scope'), 'auth_user');
assert.equal(location.searchParams.get('redirect_uri'), baseEnv.ALIPAY_MOBILE_AUTH_REDIRECT_URL);

console.log('auth-provider-bridge.test.js passed');
