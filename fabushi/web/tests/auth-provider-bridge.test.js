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

let sentEmail = null;
const bindingOnlyEnv = {
  ...baseEnv,
  FROM_EMAIL: 'amitabha@ombhrum.com',
  EMAIL: { async send() { throw new Error('must stay gated'); } },
};
const bindingOnlyCapabilities = await handleAuthProviderBridgeRequest({
  pathname: '/api/internal/auth-provider/capabilities',
  method: 'GET',
  request: new Request('https://legacy.example/api/internal/auth-provider/capabilities', { headers }),
  env: bindingOnlyEnv,
});
assert.deepEqual(await bindingOnlyCapabilities.json(), { ok: true, alipay: true, email: false });

const emailEnv = {
  ...bindingOnlyEnv,
  AUTH_REGISTRATION_EMAIL_READY: 'true',
  EMAIL: {
    async send(message) { sentEmail = message; return { messageId: 'test-message' }; },
  },
};
const emailCapabilities = await handleAuthProviderBridgeRequest({
  pathname: '/api/internal/auth-provider/capabilities',
  method: 'GET',
  request: new Request('https://legacy.example/api/internal/auth-provider/capabilities', { headers }),
  env: emailEnv,
});
assert.deepEqual(await emailCapabilities.json(), { ok: true, alipay: true, email: true });

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
assert.equal((await emailResponse.json()).provider, 'cloudflare-email');
assert.equal(sentEmail.to, 'user@example.com');
assert.equal(sentEmail.from, 'amitabha@ombhrum.com');
assert.match(sentEmail.text, /123456/);

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
