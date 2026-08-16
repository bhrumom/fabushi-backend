import { jsonResponse } from '../utils/response.js';

const BRIDGE_HEADER = 'X-Fabushi-Auth-Bridge';
const ALIPAY_AUTHORIZE_URL = 'https://openauth.alipay.com/oauth2/publicAppAuthorize.htm';
const FABUSHI_BROWSER_STATE = /^fbs_[a-f0-9]{32}$/i;

function timingSafeEqualText(left, right) {
  const a = new TextEncoder().encode(String(left || ''));
  const b = new TextEncoder().encode(String(right || ''));
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < a.byteLength; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

function bridgeAuthorized(request, env) {
  const expected = String(env.AUTH_PROVIDER_BRIDGE_SECRET || '');
  const provided = request.headers.get(BRIDGE_HEADER) || '';
  return expected.length >= 32 && timingSafeEqualText(expected, provided);
}

function alipayConfigured(env) {
  return Boolean(env.ALIPAY_APP_ID && env.ALIPAY_PRIVATE_KEY && env.ALIPAY_PUBLIC_KEY);
}

function emailConfigured(env) {
  return Boolean(env.EMAIL || (env.RESEND_API_KEY && env.FROM_EMAIL));
}

function bridgeUnauthorized() {
  return jsonResponse({ ok: false, error: 'bridge_unauthorized' }, 403);
}

function alipayCallbackUrl(env) {
  return env.ALIPAY_MOBILE_AUTH_REDIRECT_URL
    || env.ALIPAY_AUTH_REDIRECT_URL
    || `${String(env.WORKER_URL || '').replace(/\/+$/, '')}/api/auth/alipay/callback`;
}

async function handleCapabilities(request, env) {
  if (!bridgeAuthorized(request, env)) return bridgeUnauthorized();
  return jsonResponse({
    ok: true,
    alipay: alipayConfigured(env),
    email: emailConfigured(env),
  });
}

async function handleAlipayAuthorize(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  if (!FABUSHI_BROWSER_STATE.test(state)) {
    return jsonResponse({ ok: false, error: 'invalid_state' }, 400);
  }
  if (!alipayConfigured(env)) {
    return jsonResponse({ ok: false, error: 'alipay_unavailable' }, 503);
  }
  const redirectUri = alipayCallbackUrl(env);
  if (!redirectUri) {
    return jsonResponse({ ok: false, error: 'alipay_callback_unavailable' }, 503);
  }
  const target = new URL(ALIPAY_AUTHORIZE_URL);
  target.searchParams.set('app_id', env.ALIPAY_APP_ID);
  target.searchParams.set('scope', 'auth_user');
  target.searchParams.set('redirect_uri', redirectUri);
  target.searchParams.set('state', state);
  return Response.redirect(target.toString(), 302);
}

async function handleAlipayExchange(request, env) {
  if (!bridgeAuthorized(request, env)) return bridgeUnauthorized();
  if (!alipayConfigured(env)) {
    return jsonResponse({ ok: false, error: 'alipay_unavailable' }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_request' }, 400);
  }
  const authCode = String(body?.authCode || '').trim();
  if (authCode.length < 10 || authCode.length > 2048) {
    return jsonResponse({ ok: false, error: 'invalid_auth_code' }, 400);
  }
  const { getAlipayUserInfo } = await import('../../alipay-login-functions.js');
  const identity = await getAlipayUserInfo(authCode, env);
  if (!identity || identity.error || identity.isMock) {
    return jsonResponse({ ok: false, error: 'alipay_identity_exchange_failed' }, 401);
  }
  const subject = String(
    identity.provider_subject
      || identity.providerSubject
      || identity.open_id
      || identity.openId
      || identity.user_id
      || identity.userId
      || identity.alipay_user_id
      || '',
  ).trim();
  if (!subject) {
    return jsonResponse({ ok: false, error: 'alipay_subject_missing' }, 502);
  }
  const legacySubject = String(
    identity.legacy_user_id
      || identity.legacyUserId
      || (identity.alipay_user_id && identity.alipay_user_id !== subject ? identity.alipay_user_id : '')
      || '',
  ).trim();
  return jsonResponse({
    ok: true,
    identity: {
      subject,
      legacySubject: legacySubject || null,
      displayName: identity.nick_name || identity.nickname || null,
      avatarUrl: identity.avatar || null,
    },
  });
}

async function handleRegistrationEmail(request, env) {
  if (!bridgeAuthorized(request, env)) return bridgeUnauthorized();
  if (!emailConfigured(env)) {
    return jsonResponse({ ok: false, error: 'email_provider_unavailable' }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_request' }, 400);
  }
  const email = String(body?.email || '').trim().toLowerCase();
  const code = String(body?.code || '').trim();
  if (email.length > 254 || !email.includes('@') || !/^\d{6}$/.test(code)) {
    return jsonResponse({ ok: false, error: 'invalid_registration_email' }, 400);
  }
  const subject = 'Fabushi 注册验证码';
  const text = `你的 Fabushi 注册验证码是：${code}\n\n验证码 10 分钟内有效。如果不是你本人操作，请忽略这封邮件。`;
  const from = env.FROM_EMAIL || 'amitabha@ombhrum.com';
  try {
    if (env.EMAIL?.send) {
      await env.EMAIL.send({ to: email, from, subject, text });
      return jsonResponse({ ok: true, provider: 'cloudflare-email' });
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [email], subject, text }),
    });
    if (!response.ok) {
      response.body?.cancel?.();
      return jsonResponse({ ok: false, error: 'email_delivery_failed' }, 502);
    }
    return jsonResponse({ ok: true, provider: 'resend' });
  } catch {
    return jsonResponse({ ok: false, error: 'email_delivery_failed' }, 502);
  }
}

export async function handleAuthProviderBridgeRequest({ pathname, method, request, env }) {
  if (pathname === '/api/internal/auth-provider/capabilities' && method === 'GET') {
    return await handleCapabilities(request, env);
  }
  if (pathname === '/api/internal/auth-provider/alipay/authorize' && method === 'GET') {
    return await handleAlipayAuthorize(request, env);
  }
  if (pathname === '/api/internal/auth-provider/alipay/exchange' && method === 'POST') {
    return await handleAlipayExchange(request, env);
  }
  if (pathname === '/api/internal/auth-provider/email/send-registration-code' && method === 'POST') {
    return await handleRegistrationEmail(request, env);
  }
  return null;
}

export function isFabushiBrowserAlipayState(state) {
  return FABUSHI_BROWSER_STATE.test(String(state || ''));
}
