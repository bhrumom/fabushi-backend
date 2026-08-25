import { verifyToken } from '../../auth-utils.js';
import { jsonResponse } from '../utils/response.js';
import { isAdminUser } from '../utils/helpers.js';
import {
  applySubscriptionEvent,
  assertIdentifier,
  assertMinorAmount,
  createPayCheckout,
  developerSummary,
  fetchPayIntent,
  normalizeCurrency,
  platformDb,
  recordVerifiedAdRevenue,
  registerDeveloper,
  requestDeveloperPayout,
  syncPaymentRevenueEvent,
  syncSubscriptionFromPayment,
  validateTwoPartySplit,
} from '../services/monetization-platform.js';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function bearer(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header : null;
}

async function tokenUser(request, env, db) {
  const authorization = bearer(request);
  if (!authorization) return { response: jsonResponse({ error: '未提供认证信息' }, 401) };
  const claims = await verifyToken(authorization.slice(7), env);
  if (!claims) return { response: jsonResponse({ error: '认证失败' }, 401) };
  let user = null;
  if (claims.userId != null && db?.getUserById) user = await db.getUserById(claims.userId);
  if (!user && claims.username && db?.getUser) user = await db.getUser(claims.username);
  const stableUserId = String(user?.id ?? claims.userId ?? claims.sub ?? claims.username ?? '').trim();
  if (!stableUserId) return { response: jsonResponse({ error: '账号身份不可用' }, 401) };
  return { authorization, claims, user, stableUserId };
}

async function requireAdmin(request, env, db) {
  const auth = await tokenUser(request, env, db);
  if (auth.response) return auth;
  if (!auth.user || !isAdminUser(auth.user, env)) return { response: jsonResponse({ error: '需要管理员权限' }, 403) };
  return auth;
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ''));
  const b = new TextEncoder().encode(String(right || ''));
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) diff |= (a[index] || 0) ^ (b[index] || 0);
  return diff === 0;
}

function requireInternalSecret(request, env, name) {
  const expected = String(env?.[name] || '');
  const authorization = bearer(request);
  const provided = authorization?.slice(7) || '';
  if (!expected) return jsonResponse({ error: `${name} 未配置` }, 503);
  if (!provided || !constantTimeEqual(provided, expected)) return jsonResponse({ error: '内部事件认证失败' }, 401);
  return null;
}

async function parseJson(request) {
  try { return await request.json(); } catch { throw new TypeError('请求 JSON 无效'); }
}

function passthrough(result) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  return new Response(result.body || '{}', { status: result.status, headers });
}

async function safeHandler(fn) {
  try {
    return await fn();
  } catch (error) {
    const message = String(error?.message || error || 'unknown error');
    const clientError = error instanceof TypeError || error instanceof RangeError || /not found|not active|budget|insufficient|compliance|idempotency|invalid/i.test(message);
    console.error('Monetization Platform request failed:', message);
    return jsonResponse({ error: message }, clientError ? 400 : 500);
  }
}

export async function handleMonetizationCheckout(request, env, db) {
  return safeHandler(async () => {
    const auth = await tokenUser(request, env, db);
    if (auth.response) return auth.response;
    const input = await parseJson(request);
    return passthrough(await createPayCheckout(env, auth.authorization, input));
  });
}

export async function handleMonetizationPayment(request, env, db) {
  return safeHandler(async () => {
    const auth = await tokenUser(request, env, db);
    if (auth.response) return auth.response;
    const paymentId = new URL(request.url).searchParams.get('paymentId');
    const result = await fetchPayIntent(env, auth.authorization, paymentId);
    if (result.status >= 200 && result.status < 300) {
      const parsed = JSON.parse(result.body || '{}');
      const id = parsed?.payment?.paymentId || parsed?.paymentId || paymentId;
      const status = parsed?.payment?.status || parsed?.status;
      if (['succeeded', 'partially_refunded', 'refunded'].includes(status)) {
        await syncPaymentRevenueEvent(platformDb(env), id);
      }
    }
    return passthrough(result);
  });
}

export async function handleMonetizationEntitlements(request, env, db) {
  return safeHandler(async () => {
    const auth = await tokenUser(request, env, db);
    if (auth.response) return auth.response;
    const database = platformDb(env);
    const rows = (await database.prepare(`
      SELECT entitlement_id, plugin_id, product_id, order_id, capability, status,
             granted_at, expires_at, revoked_at
        FROM entitlements
       WHERE user_id = ?
       ORDER BY granted_at DESC
       LIMIT 200
    `).bind(auth.stableUserId).all()).results || [];
    return jsonResponse({ userId: auth.stableUserId, entitlements: rows });
  });
}

export async function handleMonetizationSubscriptions(request, env, db) {
  return safeHandler(async () => {
    const auth = await tokenUser(request, env, db);
    if (auth.response) return auth.response;
    const database = platformDb(env);
    const payments = (await database.prepare(`
      SELECT payment_id, user_id, mini_app_id, developer_id, product_id, price_id,
             entitlement_capability, rail, provider_reference, status, product_kind, created_at
        FROM payment_intents
       WHERE user_id = ? AND product_kind = 'subscription'
         AND status IN ('succeeded','partially_refunded')
       ORDER BY created_at DESC LIMIT 100
    `).bind(auth.stableUserId).all()).results || [];
    for (const payment of payments) await syncSubscriptionFromPayment(database, payment);
    const subscriptions = (await database.prepare(`
      SELECT * FROM monetization_subscriptions
       WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100
    `).bind(auth.stableUserId).all()).results || [];
    return jsonResponse({ userId: auth.stableUserId, subscriptions });
  });
}

export async function handleDeveloperRegister(request, env, db) {
  return safeHandler(async () => {
    const auth = await tokenUser(request, env, db);
    if (auth.response) return auth.response;
    const profile = await registerDeveloper(platformDb(env), auth.stableUserId, await parseJson(request));
    return jsonResponse({ profile }, 201);
  });
}

export async function handleDeveloperSummary(request, env, db) {
  return safeHandler(async () => {
    const auth = await tokenUser(request, env, db);
    if (auth.response) return auth.response;
    const database = platformDb(env);
    const profile = await database.prepare('SELECT developer_id FROM monetization_developer_profiles WHERE owner_user_id = ?')
      .bind(auth.stableUserId).first();
    if (profile?.developer_id) {
      const pending = (await database.prepare(`
        SELECT payment_id FROM payment_intents
         WHERE developer_id = ? AND status IN ('succeeded','partially_refunded','refunded')
         ORDER BY created_at DESC LIMIT 100
      `).bind(profile.developer_id).all()).results || [];
      for (const payment of pending) await syncPaymentRevenueEvent(database, payment.payment_id);
    }
    return jsonResponse(await developerSummary(database, auth.stableUserId));
  });
}

export async function handleDeveloperPayoutRequest(request, env, db) {
  return safeHandler(async () => {
    const auth = await tokenUser(request, env, db);
    if (auth.response) return auth.response;
    const result = await requestDeveloperPayout(platformDb(env), auth.stableUserId, await parseJson(request));
    return jsonResponse({ payoutRequest: result }, result.duplicate ? 200 : 201);
  });
}

export async function handleProviderSubscriptionEvent(request, env) {
  return safeHandler(async () => {
    const rejected = requireInternalSecret(request, env, 'MONETIZATION_PROVIDER_EVENT_SECRET');
    if (rejected) return rejected;
    const result = await applySubscriptionEvent(platformDb(env), await parseJson(request));
    return jsonResponse({ ok: true, ...result });
  });
}

export async function handleTrustedAdEvent(request, env) {
  return safeHandler(async () => {
    const rejected = requireInternalSecret(request, env, 'MONETIZATION_AD_EVENT_SECRET');
    if (rejected) return rejected;
    const result = await recordVerifiedAdRevenue(platformDb(env), await parseJson(request));
    return jsonResponse({ ok: true, ...result }, result.duplicate ? 200 : 201);
  });
}

export async function handleAdminSplitRule(request, env, db) {
  return safeHandler(async () => {
    const auth = await requireAdmin(request, env, db);
    if (auth.response) return auth.response;
    const database = platformDb(env);
    const input = await parseJson(request);
    const scopeType = String(input.scopeType || '').trim();
    if (!['platform', 'miniapp', 'product', 'ad_placement'].includes(scopeType)) throw new TypeError('scopeType 无效');
    const scopeId = assertIdentifier(input.scopeId, 'scopeId');
    const revenueSource = String(input.revenueSource || '').trim();
    if (!['purchase','subscription','ad_impression','ad_click','ad_conversion','ad_rewarded','tip','api_usage','adjustment'].includes(revenueSource)) {
      throw new TypeError('revenueSource 无效');
    }
    const split = validateTwoPartySplit(input.rule);
    const effectiveFrom = Number(input.effectiveFrom || nowSeconds());
    if (!Number.isSafeInteger(effectiveFrom) || effectiveFrom <= 0) throw new TypeError('effectiveFrom 无效');
    const current = await database.prepare(`SELECT COALESCE(MAX(version), 0) AS version
      FROM monetization_split_rules WHERE scope_type = ? AND scope_id = ? AND revenue_source = ?`)
      .bind(scopeType, scopeId, revenueSource).first();
    const version = Number(current?.version || 0) + 1;
    const ruleId = `split:${scopeType}:${scopeId}:${revenueSource}:v${version}`;
    await database.prepare(`INSERT INTO monetization_split_rules
      (rule_id, scope_type, scope_id, revenue_source, version, effective_from, effective_to,
       status, rule_json, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?)`)
      .bind(ruleId, scopeType, scopeId, revenueSource, version, effectiveFrom,
        JSON.stringify(split), auth.stableUserId, nowSeconds()).run();
    return jsonResponse({ ruleId, version, scopeType, scopeId, revenueSource, effectiveFrom, rule: split }, 201);
  });
}

export async function handleAdminAdCampaign(request, env, db) {
  return safeHandler(async () => {
    const auth = await requireAdmin(request, env, db);
    if (auth.response) return auth.response;
    const input = await parseJson(request);
    const campaignId = assertIdentifier(input.campaignId, 'campaignId');
    const advertiserId = assertIdentifier(input.advertiserId, 'advertiserId');
    const billingModel = String(input.billingModel || '').trim();
    if (!['cpm','cpc','cpa','rewarded'].includes(billingModel)) throw new TypeError('billingModel 无效');
    const currency = normalizeCurrency(input.currency);
    const bidAmount = assertMinorAmount(input.bidAmount, 'bidAmount');
    const dailyBudget = assertMinorAmount(input.dailyBudget, 'dailyBudget');
    const totalBudget = assertMinorAmount(input.totalBudget, 'totalBudget');
    const status = String(input.status || 'draft');
    if (!['draft','active','paused','ended'].includes(status)) throw new TypeError('status 无效');
    const startsAt = Number(input.startsAt || nowSeconds());
    const endsAt = input.endsAt == null ? null : Number(input.endsAt);
    if (!Number.isSafeInteger(startsAt) || (endsAt != null && (!Number.isSafeInteger(endsAt) || endsAt <= startsAt))) throw new TypeError('投放时间无效');
    const database = platformDb(env);
    const now = nowSeconds();
    await database.prepare(`INSERT INTO monetization_ad_campaigns
      (campaign_id, advertiser_id, billing_model, currency, bid_amount, daily_budget, total_budget,
       spent_amount, status, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(campaign_id) DO UPDATE SET advertiser_id = excluded.advertiser_id,
        billing_model = excluded.billing_model, currency = excluded.currency,
        bid_amount = excluded.bid_amount, daily_budget = excluded.daily_budget,
        total_budget = excluded.total_budget, status = excluded.status,
        starts_at = excluded.starts_at, ends_at = excluded.ends_at, updated_at = excluded.updated_at`)
      .bind(campaignId, advertiserId, billingModel, currency, bidAmount, dailyBudget,
        totalBudget, status, startsAt, endsAt, now, now).run();
    return jsonResponse({ campaignId, advertiserId, billingModel, currency, bidAmount, dailyBudget, totalBudget, status }, 201);
  });
}

export async function handleAdminAdPlacement(request, env, db) {
  return safeHandler(async () => {
    const auth = await requireAdmin(request, env, db);
    if (auth.response) return auth.response;
    const input = await parseJson(request);
    const placementId = assertIdentifier(input.placementId, 'placementId');
    const miniAppId = assertIdentifier(input.miniAppId, 'miniAppId');
    const developerId = assertIdentifier(input.developerId, 'developerId');
    const displayName = String(input.displayName || placementId).trim().slice(0, 120);
    const format = String(input.format || 'native').trim();
    if (!['banner','native','interstitial','rewarded'].includes(format)) throw new TypeError('format 无效');
    const developerShareBps = Number(input.developerShareBps ?? 7000);
    validateTwoPartySplit({ platformBps: 10000 - developerShareBps, developerBps: developerShareBps });
    const status = String(input.status || 'active');
    if (!['active','paused','disabled'].includes(status)) throw new TypeError('status 无效');
    const now = nowSeconds();
    await platformDb(env).prepare(`INSERT INTO monetization_ad_placements
      (placement_id, mini_app_id, developer_id, display_name, format, developer_share_bps,
       status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(placement_id) DO UPDATE SET mini_app_id = excluded.mini_app_id,
        developer_id = excluded.developer_id, display_name = excluded.display_name,
        format = excluded.format, developer_share_bps = excluded.developer_share_bps,
        status = excluded.status, updated_at = excluded.updated_at`)
      .bind(placementId, miniAppId, developerId, displayName, format, developerShareBps, status, now, now).run();
    return jsonResponse({ placementId, miniAppId, developerId, displayName, format, developerShareBps, status }, 201);
  });
}

export async function handleAdminDeveloperCompliance(request, env, db) {
  return safeHandler(async () => {
    const auth = await requireAdmin(request, env, db);
    if (auth.response) return auth.response;
    const input = await parseJson(request);
    const developerId = assertIdentifier(input.developerId, 'developerId');
    const state = String(input.complianceState || '').trim();
    if (!['pending','reviewing','verified','restricted','rejected'].includes(state)) throw new TypeError('complianceState 无效');
    const payoutEnabled = state === 'verified' && Boolean(input.payoutEnabled) ? 1 : 0;
    await platformDb(env).prepare(`UPDATE monetization_developer_profiles
      SET compliance_state = ?, payout_enabled = ?, external_kyc_reference = ?,
          tax_profile_reference = ?, updated_at = ? WHERE developer_id = ?`)
      .bind(state, payoutEnabled, input.externalKycReference || null, input.taxProfileReference || null,
        nowSeconds(), developerId).run();
    return jsonResponse({ developerId, complianceState: state, payoutEnabled: Boolean(payoutEnabled) });
  });
}

async function payAdminCall(env, path, body) {
  const secret = String(env?.FABUSHI_PAY_ADMIN_TOKEN || '');
  if (!secret) return { status: 503, body: JSON.stringify({ error: 'FABUSHI_PAY_ADMIN_TOKEN 未配置' }) };
  const base = String(env?.FABUSHI_PAY_URL || 'https://pay.ombhrum.com').replace(/\/+$/, '');
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
  });
  return { status: response.status, body: await response.text() };
}

export async function handleAdminSubmitPayout(request, env, db) {
  return safeHandler(async () => {
    const auth = await requireAdmin(request, env, db);
    if (auth.response) return auth.response;
    const input = await parseJson(request);
    const requestId = assertIdentifier(input.requestId, 'requestId');
    const database = platformDb(env);
    const row = await database.prepare(`SELECT r.*, p.compliance_state, p.payout_enabled
      FROM monetization_payout_requests r
      JOIN monetization_developer_profiles p ON p.developer_id = r.developer_id
      WHERE r.request_id = ?`).bind(requestId).first();
    if (!row) throw new Error('payout request not found');
    if (!['requested','reviewing','approved'].includes(row.status)) throw new Error('payout request is not submit-ready');
    if (row.compliance_state !== 'verified' || Number(row.payout_enabled) !== 1) throw new Error('developer compliance no longer allows payout');
    const result = await payAdminCall(env, '/v1/pay/admin/payouts', {
      idempotencyKey: `monetization:${row.idempotency_key}`,
      developerId: row.developer_id,
      payoutAccountId: row.payout_account_id,
      currency: row.currency,
      amount: Number(row.amount),
    });
    if (result.status < 200 || result.status >= 300) return passthrough(result);
    const response = JSON.parse(result.body || '{}');
    const payoutId = response?.payout?.payoutId || response?.payoutId;
    if (!payoutId) throw new Error('Fabushi Pay did not return payoutId');
    await database.prepare(`UPDATE monetization_payout_requests
      SET status = 'submitted', canonical_payout_id = ?, updated_at = ? WHERE request_id = ?`)
      .bind(payoutId, nowSeconds(), requestId).run();
    return jsonResponse({ requestId, payoutId, status: 'submitted' });
  });
}

export async function handleAdminReleaseSettlement(request, env, db) {
  return safeHandler(async () => {
    const auth = await requireAdmin(request, env, db);
    if (auth.response) return auth.response;
    const input = await parseJson(request);
    const paymentId = assertIdentifier(input.paymentId, 'paymentId');
    const idempotencyKey = assertIdentifier(input.idempotencyKey, 'idempotencyKey');
    const reserveBps = Number(input.reserveBps ?? 0);
    if (!Number.isInteger(reserveBps) || reserveBps < 0 || reserveBps > 10000) throw new TypeError('reserveBps 无效');
    const result = await payAdminCall(env, '/v1/pay/admin/settlements/release', {
      paymentId,
      idempotencyKey,
      reserveBps,
      holdPeriodSeconds: Number(input.holdPeriodSeconds ?? 7 * 24 * 60 * 60),
    });
    if (result.status >= 200 && result.status < 300) await syncPaymentRevenueEvent(platformDb(env), paymentId);
    return passthrough(result);
  });
}

export async function handleAdminPayoutAccount(request, env, db) {
  return safeHandler(async () => {
    const auth = await requireAdmin(request, env, db);
    if (auth.response) return auth.response;
    const input = await parseJson(request);
    const result = await payAdminCall(env, '/v1/pay/admin/payout-accounts', {
      payoutAccountId: assertIdentifier(input.payoutAccountId, 'payoutAccountId'),
      developerId: assertIdentifier(input.developerId, 'developerId'),
      provider: assertIdentifier(input.provider, 'provider'),
      externalAccountReference: assertIdentifier(input.externalAccountReference, 'externalAccountReference'),
    });
    return passthrough(result);
  });
}
