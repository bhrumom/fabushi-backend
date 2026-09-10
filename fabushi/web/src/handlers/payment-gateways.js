import { jsonResponse } from '../utils/response.js';
import { platformDb } from '../services/monetization-platform.js';
import {
  generateSign,
  importPrivateKey,
  importPublicKey,
  verifySign,
} from '../../alipay-utils.js';

const SUCCESS_STATUSES = new Set(['succeeded', 'partially_refunded', 'refunded']);
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
const STRIPE_CHECKOUT_HOST = 'checkout.stripe.com';
const ALIPAY_GATEWAYS = Object.freeze({
  production: 'https://openapi.alipay.com/gateway.do',
  sandbox: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
});

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isSafeIdentifier(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(String(value || '').trim());
}

function base64UrlToBytes(value) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new TypeError('Invalid base64url value');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlToText(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function hexToBytes(value) {
  const text = String(value || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(text)) throw new TypeError('Invalid hex signature');
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function safeFrontendURL(env, paymentId, extra = {}) {
  const base = String(env?.FRONTEND_URL || 'https://flutter.ombhrum.com').replace(/\/+$/, '');
  const url = new URL(`${base}/payment-success.html`);
  url.searchParams.set('paymentId', paymentId);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function getPayment(paymentId, env) {
  return platformDb(env).prepare(`
    SELECT payment_id, user_id, mini_app_id, sku, product_kind, rail,
           currency, amount, status
      FROM payment_intents
     WHERE payment_id = ?
  `).bind(paymentId).first();
}

async function verifyCheckoutToken(token, payment, env) {
  const secret = String(env?.FABUSHI_PAY_WEBHOOK_SECRET || '').trim();
  const parts = String(token || '').split('.');
  if (!secret || parts.length !== 2 || !parts[0] || !parts[1]) return false;

  let signature;
  let claims;
  try {
    signature = base64UrlToBytes(parts[1]);
    claims = JSON.parse(base64UrlToText(parts[0]));
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const validSignature = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(parts[0]),
  );
  if (!validSignature || claims?.v !== 1) return false;
  if (String(claims.paymentId || '') !== String(payment.payment_id || '')) return false;
  if (String(claims.userId || '') !== String(payment.user_id || '')) return false;
  return Number.isSafeInteger(Number(claims.exp)) && Number(claims.exp) >= nowSeconds();
}

async function loadCheckout(request, env) {
  const url = new URL(request.url);
  const paymentId = String(url.searchParams.get('paymentId') || '').trim();
  if (!isSafeIdentifier(paymentId)) return { response: jsonResponse({ error: 'payment_id_invalid' }, 400) };
  const payment = await getPayment(paymentId, env);
  if (!payment) return { response: jsonResponse({ error: 'payment_not_found' }, 404) };
  if (!(await verifyCheckoutToken(url.searchParams.get('checkoutToken'), payment, env))) {
    return { response: jsonResponse({ error: 'checkout_token_invalid' }, 401) };
  }
  if (payment.rail !== 'web_provider') {
    return { response: jsonResponse({ error: 'payment_rail_not_supported' }, 409) };
  }
  return { payment, checkoutToken: url.searchParams.get('checkoutToken') };
}

function redirectResponse(url, provider) {
  const target = new URL(url);
  const allowedHosts = provider === 'stripe'
    ? new Set([STRIPE_CHECKOUT_HOST])
    : new Set([new URL(ALIPAY_GATEWAYS.production).hostname, new URL(ALIPAY_GATEWAYS.sandbox).hostname]);
  if (target.protocol !== 'https:' || !allowedHosts.has(target.hostname)) {
    throw new Error(`${provider} returned an unsafe checkout URL`);
  }
  return Response.redirect(target.toString(), 303);
}

function stripeErrorCode(body) {
  try {
    const parsed = JSON.parse(body || '{}');
    return String(parsed?.error?.code || parsed?.error?.type || 'provider_error').slice(0, 80);
  } catch {
    return 'provider_error';
  }
}

export async function handleStripeCheckout(request, env) {
  try {
    const loaded = await loadCheckout(request, env);
    if (loaded.response) return loaded.response;
    const { payment, checkoutToken } = loaded;
    if (SUCCESS_STATUSES.has(String(payment.status))) {
      return Response.redirect(safeFrontendURL(env, payment.payment_id, { alreadyPaid: '1' }), 303);
    }
    if (String(payment.product_kind) === 'subscription') {
      return jsonResponse({ error: 'stripe_dynamic_subscription_not_enabled' }, 409);
    }

    const secret = String(env?.STRIPE_SECRET_KEY || '').trim();
    if (!secret) return jsonResponse({ error: 'STRIPE_SECRET_KEY 未配置' }, 503);
    const currency = String(payment.currency || '').trim().toLowerCase();
    const amount = Number(payment.amount);
    if (!/^[a-z]{3}$/.test(currency) || !Number.isSafeInteger(amount) || amount <= 0) {
      return jsonResponse({ error: 'payment_amount_invalid' }, 409);
    }

    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('line_items[0][price_data][currency]', currency);
    form.set('line_items[0][price_data][unit_amount]', String(amount));
    form.set('line_items[0][price_data][product_data][name]', `Fabushi · ${String(payment.sku).slice(0, 180)}`);
    form.set('line_items[0][quantity]', '1');
    form.set('client_reference_id', String(payment.payment_id));
    form.set('metadata[paymentId]', String(payment.payment_id));
    form.set('metadata[miniAppId]', String(payment.mini_app_id));
    form.set('metadata[sku]', String(payment.sku));
    form.set('payment_intent_data[metadata][paymentId]', String(payment.payment_id));
    form.set('success_url', safeFrontendURL(env, payment.payment_id, { checkoutToken }));
    form.set('cancel_url', safeFrontendURL(env, payment.payment_id, { cancelled: '1', checkoutToken }));

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'Idempotency-Key': `fabushi-checkout-${payment.payment_id}`,
      },
      body: form.toString(),
      redirect: 'error',
    });
    const body = await response.text();
    if (!response.ok) {
      console.error('Stripe Checkout session creation failed:', response.status, stripeErrorCode(body));
      return jsonResponse({ error: 'stripe_checkout_unavailable', code: stripeErrorCode(body) }, 502);
    }
    const session = JSON.parse(body);
    if (!session?.url) return jsonResponse({ error: 'stripe_checkout_url_missing' }, 502);
    return redirectResponse(session.url, 'stripe');
  } catch (error) {
    console.error('Stripe checkout gateway failed:', error?.message || error);
    return jsonResponse({ error: 'stripe_checkout_unavailable' }, 500);
  }
}

function parseStripeSignature(header) {
  const values = new Map();
  for (const part of String(header || '').split(',')) {
    const [key, value] = part.split('=', 2).map((item) => String(item || '').trim());
    if (!key || !value) continue;
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  }
  return { timestamp: Number(values.get('t')?.[0]), signatures: values.get('v1') || [] };
}

async function verifyStripeSignature(payload, header, secret) {
  const { timestamp, signatures } = parseStripeSignature(header);
  if (!Number.isSafeInteger(timestamp) || !signatures.length) return false;
  if (Math.abs(nowSeconds() - timestamp) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signedPayload = new TextEncoder().encode(`${timestamp}.${payload}`);
  for (const signature of signatures) {
    try {
      if (await crypto.subtle.verify('HMAC', key, hexToBytes(signature), signedPayload)) return true;
    } catch {
      // Ignore malformed signatures and continue checking any other v1 value.
    }
  }
  return false;
}

function paymentIdFromStripeSession(session) {
  const metadataId = String(session?.metadata?.paymentId || '').trim();
  const clientReferenceId = String(session?.client_reference_id || '').trim();
  if (metadataId && clientReferenceId && metadataId !== clientReferenceId) return null;
  return metadataId || clientReferenceId || null;
}

async function forwardCanonicalEvent(env, provider, event) {
  const base = String(env?.FABUSHI_PAY_URL || 'https://pay.ombhrum.com').replace(/\/+$/, '');
  const secret = String(env?.FABUSHI_PAY_WEBHOOK_SECRET || '').trim();
  if (!secret) return { ok: false, status: 503 };
  const response = await fetch(`${base}/v1/pay/providers/${encodeURIComponent(provider)}/webhook`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(event),
    redirect: 'error',
  });
  return { ok: response.ok, status: response.status, body: await response.text() };
}

export async function handleStripeWebhook(request, env) {
  const body = await request.text();
  const secret = String(env?.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!secret) return new Response('Stripe webhook is not configured', { status: 503 });
  if (!(await verifyStripeSignature(body, request.headers.get('Stripe-Signature'), secret))) {
    return new Response('Invalid Stripe signature', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response('Invalid Stripe event', { status: 400 });
  }
  const expectedLiveMode = String(env?.STRIPE_LIVEMODE || '').trim().toLowerCase();
  if ((expectedLiveMode === 'true' && event.livemode !== true) || (expectedLiveMode === 'false' && event.livemode !== false)) {
    return new Response('Stripe livemode mismatch', { status: 400 });
  }

  const session = event?.data?.object;
  const eventType = String(event?.type || '');
  const handledTypes = new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
  ]);
  if (!session || !handledTypes.has(eventType)) return jsonResponse({ ok: true, ignored: true });
  const paymentId = paymentIdFromStripeSession(session);
  if (!paymentId || !isSafeIdentifier(paymentId)) return new Response('Stripe session is missing paymentId', { status: 400 });
  let normalizedType = 'paymentSucceeded';
  if (eventType === 'checkout.session.async_payment_failed') normalizedType = 'paymentFailed';
  if (eventType === 'checkout.session.expired') normalizedType = 'paymentCancelled';
  if (eventType === 'checkout.session.completed' && session.payment_status !== 'paid') {
    return jsonResponse({ ok: true, ignored: true, reason: 'payment_not_paid' });
  }

  const payment = await getPayment(paymentId, env);
  if (!payment || payment.rail !== 'web_provider') return new Response('Stripe payment intent not found', { status: 400 });
  if (normalizedType === 'paymentSucceeded') {
    const total = Number(session.amount_total);
    const currency = String(session.currency || '').toLowerCase();
    if (!Number.isSafeInteger(total) || total !== Number(payment.amount) || currency !== String(payment.currency).toLowerCase()) {
      return new Response('Stripe amount or currency mismatch', { status: 400 });
    }
  }

  const providerReference = String(session.id || '').trim();
  if (!isSafeIdentifier(providerReference)) return new Response('Stripe session is missing id', { status: 400 });
  const forwarded = await forwardCanonicalEvent(env, 'stripe', {
    eventId: `stripe:${String(event.id || providerReference)}`,
    eventType: normalizedType,
    paymentId: String(payment.payment_id),
    providerReference,
    amount: normalizedType === 'paymentSucceeded' ? Number(payment.amount) : undefined,
    occurredAt: Number(event.created) || nowSeconds(),
  });
  if (!forwarded.ok) {
    console.error('Canonical Stripe webhook rejected:', forwarded.status);
    return new Response('Canonical payment webhook failed', { status: 502 });
  }
  return jsonResponse({ ok: true, paymentId: payment.payment_id });
}

function normalizePublicKey(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('ALIPAY_PUBLIC_KEY is missing');
  if (raw.includes('BEGIN PUBLIC KEY')) return raw;
  return `-----BEGIN PUBLIC KEY-----\n${raw.replace(/\s+/g, '')}\n-----END PUBLIC KEY-----`;
}

function timestampText() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

function cnyAmount(minorAmount) {
  const amount = Number(minorAmount);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError('CNY amount is invalid');
  return (amount / 100).toFixed(2);
}

async function verifyAlipayNotification(params, env) {
  if (!params.sign || params.sign_type !== 'RSA2') return false;
  if (!env.ALIPAY_APP_ID || params.app_id !== env.ALIPAY_APP_ID) return false;
  if (env.ALIPAY_SELLER_ID && params.seller_id !== env.ALIPAY_SELLER_ID) return false;
  const signedParams = { ...params };
  const sign = signedParams.sign;
  delete signedParams.sign;
  delete signedParams.sign_type;
  const publicKey = await importPublicKey(normalizePublicKey(env.ALIPAY_PUBLIC_KEY));
  return verifySign(signedParams, sign, publicKey);
}

export async function handleAlipayCheckout(request, env) {
  try {
    const loaded = await loadCheckout(request, env);
    if (loaded.response) return loaded.response;
    const { payment, checkoutToken } = loaded;
    if (SUCCESS_STATUSES.has(String(payment.status))) {
      return Response.redirect(safeFrontendURL(env, payment.payment_id, { alreadyPaid: '1' }), 303);
    }
    if (String(payment.currency).toUpperCase() !== 'CNY') return jsonResponse({ error: 'alipay_requires_cny' }, 409);
    if (!env.ALIPAY_APP_ID || !env.ALIPAY_PRIVATE_KEY) return jsonResponse({ error: '支付宝生产密钥未配置' }, 503);

    const privateKey = await importPrivateKey(env.ALIPAY_PRIVATE_KEY);
    const notifyURL = new URL('/api/pay/alipay/webhook', request.url).toString();
    const params = {
      app_id: env.ALIPAY_APP_ID,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: timestampText(),
      version: '1.0',
      notify_url: notifyURL,
      return_url: safeFrontendURL(env, payment.payment_id, { checkoutToken }),
      method: 'alipay.trade.page.pay',
      biz_content: JSON.stringify({
        out_trade_no: String(payment.payment_id),
        total_amount: cnyAmount(payment.amount),
        subject: `全球法布施 - ${String(payment.sku).slice(0, 80)}`,
        product_code: 'FAST_INSTANT_TRADE_PAY',
        timeout_express: '30m',
      }),
    };
    params.sign = await generateSign(params, privateKey);
    const gateway = env.ALIPAY_SANDBOX === 'true' ? ALIPAY_GATEWAYS.sandbox : ALIPAY_GATEWAYS.production;
    return redirectResponse(`${gateway}?${new URLSearchParams(params).toString()}`, 'alipay');
  } catch (error) {
    console.error('Alipay checkout gateway failed:', error?.message || error);
    return jsonResponse({ error: 'alipay_checkout_unavailable' }, 500);
  }
}

export async function handlePaymentStatus(request, env) {
  const url = new URL(request.url);
  const paymentId = String(url.searchParams.get('paymentId') || '').trim();
  if (!isSafeIdentifier(paymentId)) return jsonResponse({ error: 'payment_id_invalid' }, 400);
  const payment = await getPayment(paymentId, env);
  if (!payment) return jsonResponse({ error: 'payment_not_found' }, 404);
  if (!(await verifyCheckoutToken(url.searchParams.get('checkoutToken'), payment, env))) {
    return jsonResponse({ error: 'checkout_token_invalid' }, 401);
  }
  return jsonResponse({
    paymentId: payment.payment_id,
    status: payment.status,
    currency: payment.currency,
    amount: payment.amount,
  });
}

export async function handleAlipayWebhook(request, env) {
  try {
    const contentType = String(request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data')) {
      return new Response('failure', { status: 415 });
    }
    const formData = await request.formData();
    const params = {};
    for (const [key, value] of formData.entries()) {
      if (Object.keys(params).length >= 80 || String(key).length > 128 || String(value).length > 8192) return new Response('failure', { status: 400 });
      params[key] = String(value);
    }
    if (!(await verifyAlipayNotification(params, env))) return new Response('failure', { status: 400 });
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(params.trade_status)) return new Response('success', { status: 200 });

    const paymentId = String(params.out_trade_no || '').trim();
    if (!isSafeIdentifier(paymentId)) return new Response('failure', { status: 400 });
    const payment = await getPayment(paymentId, env);
    if (!payment || payment.rail !== 'web_provider' || String(payment.currency).toUpperCase() !== 'CNY') return new Response('failure', { status: 400 });
    if (!Number.isFinite(Number(params.total_amount)) || Number(params.total_amount).toFixed(2) !== cnyAmount(payment.amount)) return new Response('failure', { status: 400 });
    const providerReference = String(params.trade_no || paymentId).trim();
    if (!isSafeIdentifier(providerReference)) return new Response('failure', { status: 400 });
    const forwarded = await forwardCanonicalEvent(env, 'alipay_platform', {
      eventId: `alipay:${providerReference}`,
      eventType: 'paymentSucceeded',
      paymentId: String(payment.payment_id),
      providerReference,
      amount: Number(payment.amount),
      occurredAt: nowSeconds(),
    });
    return forwarded.ok ? new Response('success', { status: 200 }) : new Response('failure', { status: 502 });
  } catch (error) {
    console.error('Alipay webhook gateway failed:', error?.message || error);
    return new Response('failure', { status: 500 });
  }
}
