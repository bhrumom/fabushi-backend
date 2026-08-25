const PAY_BASE_URL = 'https://pay.ombhrum.com';
const ALLOWED_RAILS = new Set([
  'credits',
  'apple_in_app_purchase',
  'google_play_billing',
  'web_provider',
  'merchant_provider',
]);
const AD_EVENT_TYPES = new Set(['impression', 'click', 'conversion', 'rewarded']);
const SUBSCRIPTION_STATES = new Set(['trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired', 'refunded']);

export function platformDb(env) {
  const db = env?.PLATFORM_DB;
  if (!db?.prepare || !db?.batch) throw new Error('PLATFORM_DB is unavailable');
  return db;
}

export function assertIdentifier(value, name = 'identifier') {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(text)) {
    throw new TypeError(`${name} is invalid`);
  }
  return text;
}

export function assertMinorAmount(value, name = 'amount') {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError(`${name} must be a positive integer minor-unit amount`);
  return amount;
}

export function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('currency must be a 3-letter code');
  return currency;
}

export function validateTwoPartySplit(rule) {
  const platformBps = Number(rule?.platformBps);
  const developerBps = Number(rule?.developerBps);
  if (!Number.isInteger(platformBps) || !Number.isInteger(developerBps)) {
    throw new TypeError('platformBps and developerBps must be integers');
  }
  if (platformBps < 0 || developerBps < 0 || platformBps > 10000 || developerBps > 10000) {
    throw new RangeError('split basis points must be between 0 and 10000');
  }
  if (platformBps + developerBps !== 10000) throw new RangeError('split basis points must total 10000');
  return { platformBps, developerBps };
}

export function allocateTwoPartySplit(grossAmount, rule) {
  const gross = assertMinorAmount(grossAmount, 'grossAmount');
  const split = validateTwoPartySplit(rule);
  const platformAmount = Math.floor((gross * split.platformBps) / 10000);
  const developerAmount = gross - platformAmount;
  return { grossAmount: gross, platformAmount, developerAmount, ...split };
}

export function adBillableAmount(campaign, eventType, quantity = 1) {
  if (!AD_EVENT_TYPES.has(eventType)) throw new TypeError('unsupported ad event type');
  const amount = assertMinorAmount(campaign?.bid_amount, 'campaign bid amount');
  const count = Number(quantity);
  if (!Number.isInteger(count) || count <= 0 || count > 1000) throw new RangeError('ad quantity must be between 1 and 1000');
  switch (campaign.billing_model) {
    case 'cpm':
      return eventType === 'impression' ? Math.floor((amount * count) / 1000) : 0;
    case 'cpc':
      return eventType === 'click' ? amount * count : 0;
    case 'cpa':
      return eventType === 'conversion' ? amount * count : 0;
    case 'rewarded':
      return eventType === 'rewarded' ? amount * count : 0;
    default:
      throw new TypeError('unsupported campaign billing model');
  }
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((item) => item.toString(16).padStart(2, '0')).join('');
}

export async function resolveSplitRule(db, { scopeType, scopeId, revenueSource, occurredAt = Math.floor(Date.now() / 1000) }) {
  const row = await db.prepare(`
    SELECT rule_id, rule_json, version, effective_from, effective_to
      FROM monetization_split_rules
     WHERE scope_type = ? AND scope_id = ? AND revenue_source = ? AND status = 'active'
       AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
     ORDER BY version DESC
     LIMIT 1
  `).bind(scopeType, scopeId, revenueSource, occurredAt, occurredAt).first();
  if (!row) return null;
  let parsed;
  try { parsed = JSON.parse(row.rule_json); } catch { throw new Error(`invalid split rule JSON for ${row.rule_id}`); }
  return { ...row, ...validateTwoPartySplit(parsed) };
}

export async function resolveRevenueSplit(db, { placement, revenueSource, occurredAt }) {
  const placementRule = await resolveSplitRule(db, {
    scopeType: 'ad_placement',
    scopeId: placement.placement_id,
    revenueSource,
    occurredAt,
  });
  if (placementRule) return placementRule;
  const miniAppRule = await resolveSplitRule(db, {
    scopeType: 'miniapp',
    scopeId: placement.mini_app_id,
    revenueSource,
    occurredAt,
  });
  if (miniAppRule) return miniAppRule;
  return {
    rule_id: null,
    version: 0,
    platformBps: 10000 - Number(placement.developer_share_bps),
    developerBps: Number(placement.developer_share_bps),
  };
}

export async function createPayCheckout(env, authorization, input) {
  if (!authorization?.startsWith('Bearer ')) throw new Error('authorization is required');
  const miniAppId = assertIdentifier(input?.miniAppId, 'miniAppId');
  const sku = assertIdentifier(input?.sku, 'sku');
  const idempotencyKey = assertIdentifier(input?.idempotencyKey, 'idempotencyKey');
  const rail = String(input?.rail || '').trim();
  if (!ALLOWED_RAILS.has(rail)) throw new TypeError('unsupported payment rail');
  const base = String(env?.FABUSHI_PAY_URL || PAY_BASE_URL).replace(/\/+$/, '');
  if (!/^https:\/\/([A-Za-z0-9.-]+)(:\d+)?$/.test(base)) throw new Error('FABUSHI_PAY_URL must be HTTPS');
  const headers = { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' };
  const intentResponse = await fetch(`${base}/v1/miniapps/${encodeURIComponent(miniAppId)}/pay/intents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sku, rail, idempotencyKey }),
    redirect: 'error',
  });
  const intentBody = await intentResponse.text();
  if (!intentResponse.ok) return { status: intentResponse.status, body: intentBody };
  const intent = JSON.parse(intentBody);
  const paymentId = assertIdentifier(intent?.payment?.paymentId || intent?.paymentId, 'paymentId');
  const checkoutResponse = await fetch(`${base}/v1/pay/intents/${encodeURIComponent(paymentId)}/checkout`, {
    method: 'POST',
    headers,
    body: '{}',
    redirect: 'error',
  });
  return { status: checkoutResponse.status, body: await checkoutResponse.text() };
}

export async function fetchPayIntent(env, authorization, paymentId) {
  const id = assertIdentifier(paymentId, 'paymentId');
  const base = String(env?.FABUSHI_PAY_URL || PAY_BASE_URL).replace(/\/+$/, '');
  const response = await fetch(`${base}/v1/pay/intents/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Authorization: authorization, Accept: 'application/json' },
    redirect: 'error',
  });
  return { status: response.status, body: await response.text() };
}

export async function syncPaymentRevenueEvent(db, paymentId, now = Math.floor(Date.now() / 1000)) {
  const id = assertIdentifier(paymentId, 'paymentId');
  const payment = await db.prepare(`
    SELECT payment_id, user_id, mini_app_id, developer_id, product_kind, currency, amount,
           platform_fee_bps, status, created_at
      FROM payment_intents WHERE payment_id = ?
  `).bind(id).first();
  if (!payment || !['succeeded', 'partially_refunded', 'refunded'].includes(payment.status)) return null;
  const gross = Number(payment.amount);
  const platformAmount = Math.floor((gross * Number(payment.platform_fee_bps)) / 10000);
  const developerAmount = gross - platformAmount;
  const sourceKind = payment.product_kind === 'subscription' ? 'subscription' : 'payment';
  const revenueSource = payment.product_kind === 'subscription' ? 'subscription' : 'purchase';
  const sourceId = `payment:${id}`;
  await db.prepare(`
    INSERT OR IGNORE INTO monetization_revenue_events
      (revenue_event_id, source_kind, source_id, payment_id, mini_app_id, developer_id,
       customer_user_id, gross_amount, platform_amount, developer_amount, currency,
       split_rule_id, status, metadata_json, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'posted', ?, ?, ?)
  `).bind(
    `revenue:${id}`, sourceKind, sourceId, id, payment.mini_app_id, payment.developer_id,
    payment.user_id, gross, platformAmount, developerAmount, payment.currency,
    JSON.stringify({ revenueSource, platformFeeBps: Number(payment.platform_fee_bps) }),
    Number(payment.created_at || now), now,
  ).run();
  if (payment.product_kind === 'subscription') await syncSubscriptionFromPayment(db, payment, now);
  return { paymentId: id, sourceKind, grossAmount: gross, platformAmount, developerAmount };
}

export async function syncSubscriptionFromPayment(db, payment, now = Math.floor(Date.now() / 1000)) {
  const full = payment.product_id ? payment : await db.prepare(`
    SELECT payment_id, user_id, mini_app_id, developer_id, product_id, price_id,
           entitlement_capability, rail, provider_reference, status, product_kind, created_at
      FROM payment_intents WHERE payment_id = ?
  `).bind(payment.payment_id).first();
  if (!full || full.product_kind !== 'subscription' || !['succeeded', 'partially_refunded'].includes(full.status)) return null;
  const provider = full.rail === 'apple_in_app_purchase' ? 'apple'
    : full.rail === 'google_play_billing' ? 'google'
      : full.rail === 'credits' ? 'credits' : 'web';
  const reference = full.provider_reference || full.payment_id;
  const subscriptionId = `subscription:${provider}:${reference}`;
  await db.prepare(`
    INSERT INTO monetization_subscriptions
      (subscription_id, user_id, mini_app_id, developer_id, product_id, price_id, payment_id,
       provider, provider_subscription_reference, entitlement_capability, status,
       current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, 0, ?, ?)
    ON CONFLICT(subscription_id) DO UPDATE SET
      payment_id = excluded.payment_id,
      status = CASE WHEN monetization_subscriptions.status IN ('cancelled','expired','refunded')
                    THEN monetization_subscriptions.status ELSE 'active' END,
      updated_at = excluded.updated_at
  `).bind(
    subscriptionId, full.user_id, full.mini_app_id, full.developer_id, full.product_id,
    full.price_id, full.payment_id, provider, reference, full.entitlement_capability,
    Number(full.created_at || now), now, now,
  ).run();
  return subscriptionId;
}

export async function applySubscriptionEvent(db, input, now = Math.floor(Date.now() / 1000)) {
  const provider = assertIdentifier(input?.provider, 'provider').toLowerCase();
  const eventId = assertIdentifier(input?.eventId, 'eventId');
  const paymentId = assertIdentifier(input?.paymentId, 'paymentId');
  const providerReference = assertIdentifier(input?.providerSubscriptionReference || paymentId, 'providerSubscriptionReference');
  const status = String(input?.status || '').trim();
  if (!SUBSCRIPTION_STATES.has(status)) throw new TypeError('invalid subscription status');
  const payloadHash = await sha256Hex(JSON.stringify(input));
  const existing = await db.prepare('SELECT payload_sha256, state FROM monetization_provider_events WHERE provider = ? AND event_id = ?')
    .bind(provider, eventId).first();
  if (existing) {
    if (existing.payload_sha256 !== payloadHash) throw new Error('provider event id was reused with a different payload');
    return { duplicate: true };
  }
  const payment = await db.prepare(`
    SELECT payment_id, user_id, mini_app_id, developer_id, product_id, price_id,
           entitlement_capability, product_kind
      FROM payment_intents WHERE payment_id = ?
  `).bind(paymentId).first();
  if (!payment || payment.product_kind !== 'subscription') throw new Error('subscription payment not found');
  const periodStart = input?.currentPeriodStart == null ? null : Number(input.currentPeriodStart);
  const periodEnd = input?.currentPeriodEnd == null ? null : Number(input.currentPeriodEnd);
  if (periodStart != null && (!Number.isSafeInteger(periodStart) || periodStart <= 0)) throw new TypeError('invalid currentPeriodStart');
  if (periodEnd != null && (!Number.isSafeInteger(periodEnd) || periodEnd <= 0)) throw new TypeError('invalid currentPeriodEnd');
  const subscriptionId = `subscription:${provider}:${providerReference}`;
  const entitlementState = ['active', 'trialing', 'past_due'].includes(status) ? 'active' : status === 'expired' ? 'expired' : 'revoked';
  const statements = [
    db.prepare(`INSERT INTO monetization_provider_events
      (provider, event_id, event_type, payload_sha256, state, subject_id, occurred_at, processed_at)
      VALUES (?, ?, 'subscription.lifecycle', ?, 'processed', ?, ?, ?)`)
      .bind(provider, eventId, payloadHash, subscriptionId, Number(input?.occurredAt || now), now),
    db.prepare(`INSERT INTO monetization_subscriptions
      (subscription_id, user_id, mini_app_id, developer_id, product_id, price_id, payment_id,
       provider, provider_subscription_reference, entitlement_capability, status,
       current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subscription_id) DO UPDATE SET
        payment_id = excluded.payment_id, status = excluded.status,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        updated_at = excluded.updated_at`)
      .bind(subscriptionId, payment.user_id, payment.mini_app_id, payment.developer_id,
        payment.product_id, payment.price_id, payment.payment_id, provider, providerReference,
        payment.entitlement_capability, status, periodStart, periodEnd,
        input?.cancelAtPeriodEnd ? 1 : 0, now, now),
    db.prepare(`UPDATE entitlements
      SET status = ?, expires_at = ?, revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END
      WHERE user_id = ? AND product_id = ? AND capability = ?`)
      .bind(entitlementState, periodEnd, entitlementState, now, payment.user_id, payment.product_id, payment.entitlement_capability),
  ];
  await db.batch(statements);
  return { duplicate: false, subscriptionId, status };
}

export async function recordVerifiedAdRevenue(db, input, now = Math.floor(Date.now() / 1000)) {
  const campaignId = assertIdentifier(input?.campaignId, 'campaignId');
  const placementId = assertIdentifier(input?.placementId, 'placementId');
  const idempotencyKey = assertIdentifier(input?.idempotencyKey, 'idempotencyKey');
  const eventType = String(input?.eventType || '').trim();
  if (!AD_EVENT_TYPES.has(eventType)) throw new TypeError('unsupported ad event type');
  const quantity = Number(input?.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1000) throw new RangeError('invalid ad quantity');
  const existing = await db.prepare('SELECT ad_event_id, verification_state FROM monetization_ad_events WHERE idempotency_key = ?')
    .bind(idempotencyKey).first();
  if (existing) return { duplicate: true, adEventId: existing.ad_event_id, verificationState: existing.verification_state };
  const campaign = await db.prepare('SELECT * FROM monetization_ad_campaigns WHERE campaign_id = ?').bind(campaignId).first();
  const placement = await db.prepare('SELECT * FROM monetization_ad_placements WHERE placement_id = ?').bind(placementId).first();
  if (!campaign || !placement) throw new Error('campaign or placement not found');
  if (campaign.status !== 'active' || placement.status !== 'active') throw new Error('campaign or placement is not active');
  if (Number(campaign.starts_at) > now || (campaign.ends_at != null && Number(campaign.ends_at) <= now)) throw new Error('campaign is outside its delivery window');
  const billableAmount = adBillableAmount(campaign, eventType, quantity);
  if (billableAmount <= 0) throw new Error('ad event is not billable for this campaign model');
  if (Number(campaign.spent_amount) + billableAmount > Number(campaign.total_budget)) throw new Error('campaign budget exhausted');
  const revenueSource = `ad_${eventType}`;
  const splitRule = await resolveRevenueSplit(db, { placement, revenueSource, occurredAt: Number(input?.occurredAt || now) });
  const split = allocateTwoPartySplit(billableAmount, splitRule);
  const adEventId = `ad:${crypto.randomUUID()}`;
  const revenueEventId = `revenue:${adEventId}`;
  const entryId = `ad-revenue:${adEventId}`;
  const currency = normalizeCurrency(campaign.currency);
  const sourceAccount = `advertiser-clearing:${campaign.advertiser_id}:${currency}`;
  const developerAccount = `developer-pending:${placement.developer_id}:${currency}`;
  const platformAccount = `platform:ad-revenue:${currency}`;
  const occurredAt = Number(input?.occurredAt || now);
  const sessionHash = input?.sessionId ? await sha256Hex(input.sessionId) : null;
  const actorHash = input?.actorId ? await sha256Hex(input.actorId) : null;
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO wallet_accounts (account_id, owner_type, owner_id, currency, created_at)
      VALUES (?, 'platform', ?, ?, ?)`).bind(sourceAccount, `advertiser-clearing:${campaign.advertiser_id}`, currency, now),
    db.prepare(`INSERT OR IGNORE INTO wallet_accounts (account_id, owner_type, owner_id, currency, created_at)
      VALUES (?, 'developer', ?, ?, ?)`).bind(developerAccount, `${placement.developer_id}:pending`, currency, now),
    db.prepare(`INSERT OR IGNORE INTO wallet_accounts (account_id, owner_type, owner_id, currency, created_at)
      VALUES (?, 'platform', 'ad-revenue', ?, ?)`).bind(platformAccount, currency, now),
    db.prepare(`INSERT INTO monetization_ad_events
      (ad_event_id, idempotency_key, campaign_id, placement_id, mini_app_id, developer_id,
       event_type, quantity, billable_amount, currency, session_hash, actor_hash,
       verification_state, verification_reason, occurred_at, verified_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', 'trusted_server_event', ?, ?, ?)`)
      .bind(adEventId, idempotencyKey, campaignId, placementId, placement.mini_app_id,
        placement.developer_id, eventType, quantity, billableAmount, currency, sessionHash,
        actorHash, occurredAt, now, now),
    db.prepare(`UPDATE monetization_ad_campaigns
      SET spent_amount = spent_amount + ?, updated_at = ?
      WHERE campaign_id = ? AND status = 'active' AND spent_amount + ? <= total_budget`)
      .bind(billableAmount, now, campaignId, billableAmount),
    db.prepare(`INSERT INTO journal_entries (entry_id, reference_type, reference_id, state, created_at, posted_at)
      VALUES (?, 'ad_revenue', ?, 'posted', ?, ?)`).bind(entryId, adEventId, now, now),
    db.prepare(`INSERT INTO journal_lines (line_id, entry_id, account_id, currency, amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(`${entryId}:source`, entryId, sourceAccount, currency, -billableAmount, now),
    db.prepare(`INSERT INTO journal_lines (line_id, entry_id, account_id, currency, amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(`${entryId}:developer`, entryId, developerAccount, currency, split.developerAmount, now),
    db.prepare(`INSERT INTO journal_lines (line_id, entry_id, account_id, currency, amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(`${entryId}:platform`, entryId, platformAccount, currency, split.platformAmount, now),
    db.prepare(`INSERT INTO monetization_revenue_events
      (revenue_event_id, source_kind, source_id, mini_app_id, developer_id, gross_amount,
       platform_amount, developer_amount, currency, split_rule_id, status, metadata_json,
       occurred_at, created_at)
      VALUES (?, 'advertising', ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)`)
      .bind(revenueEventId, adEventId, placement.mini_app_id, placement.developer_id,
        billableAmount, split.platformAmount, split.developerAmount, currency,
        splitRule.rule_id || null, JSON.stringify({ eventType, campaignId, placementId, quantity }),
        occurredAt, now),
  ];
  await db.batch(statements);
  return { duplicate: false, adEventId, revenueEventId, billableAmount, currency, ...split };
}

export async function registerDeveloper(db, userId, input, now = Math.floor(Date.now() / 1000)) {
  const ownerUserId = assertIdentifier(userId, 'userId');
  const developerId = assertIdentifier(input?.developerId || `developer:${ownerUserId}`, 'developerId');
  const displayName = String(input?.displayName || developerId).trim().slice(0, 120);
  if (!displayName) throw new TypeError('displayName is required');
  await db.prepare(`INSERT INTO monetization_developer_profiles
    (developer_id, owner_user_id, display_name, compliance_state, payout_enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 0, ?, ?)
    ON CONFLICT(owner_user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`)
    .bind(developerId, ownerUserId, displayName, now, now).run();
  return await db.prepare('SELECT * FROM monetization_developer_profiles WHERE owner_user_id = ?').bind(ownerUserId).first();
}

export async function requestDeveloperPayout(db, userId, input, now = Math.floor(Date.now() / 1000)) {
  const ownerUserId = assertIdentifier(userId, 'userId');
  const payoutAccountId = assertIdentifier(input?.payoutAccountId, 'payoutAccountId');
  const idempotencyKey = assertIdentifier(input?.idempotencyKey, 'idempotencyKey');
  const currency = normalizeCurrency(input?.currency);
  const amount = assertMinorAmount(input?.amount, 'amount');
  const profile = await db.prepare('SELECT * FROM monetization_developer_profiles WHERE owner_user_id = ?').bind(ownerUserId).first();
  if (!profile) throw new Error('developer profile not found');
  if (profile.compliance_state !== 'verified' || Number(profile.payout_enabled) !== 1) throw new Error('developer payout is not compliance-enabled');
  const account = await db.prepare(`SELECT payout_account_id FROM developer_payout_accounts
    WHERE payout_account_id = ? AND developer_id = ? AND state = 'active'`)
    .bind(payoutAccountId, profile.developer_id).first();
  if (!account) throw new Error('payout account is not active');
  const balance = await db.prepare('SELECT balance FROM wallet_balances WHERE account_id = ?')
    .bind(`developer-available:${profile.developer_id}:${currency}`).first();
  if (Number(balance?.balance || 0) < amount) throw new Error('insufficient developer available balance');
  const existing = await db.prepare('SELECT * FROM monetization_payout_requests WHERE idempotency_key = ?').bind(idempotencyKey).first();
  if (existing) return { ...existing, duplicate: true };
  const requestId = `payout-request:${crypto.randomUUID()}`;
  await db.prepare(`INSERT INTO monetization_payout_requests
    (request_id, developer_id, requester_user_id, payout_account_id, currency, amount,
     idempotency_key, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`)
    .bind(requestId, profile.developer_id, ownerUserId, payoutAccountId, currency, amount, idempotencyKey, now, now).run();
  return { requestId, developerId: profile.developer_id, payoutAccountId, currency, amount, status: 'requested', duplicate: false };
}

export async function developerSummary(db, userId, now = Math.floor(Date.now() / 1000)) {
  const ownerUserId = assertIdentifier(userId, 'userId');
  const profile = await db.prepare('SELECT * FROM monetization_developer_profiles WHERE owner_user_id = ?').bind(ownerUserId).first();
  if (!profile) return { profile: null, balances: [], revenue: [], subscriptions: [], payouts: [] };
  const balances = (await db.prepare('SELECT * FROM monetization_developer_balances WHERE developer_id = ?').bind(profile.developer_id).all()).results || [];
  const revenue = (await db.prepare(`SELECT * FROM monetization_revenue_events
    WHERE developer_id = ? ORDER BY occurred_at DESC LIMIT 100`).bind(profile.developer_id).all()).results || [];
  const subscriptions = (await db.prepare(`SELECT * FROM monetization_subscriptions
    WHERE developer_id = ? ORDER BY updated_at DESC LIMIT 100`).bind(profile.developer_id).all()).results || [];
  const payouts = (await db.prepare(`SELECT * FROM monetization_payout_requests
    WHERE developer_id = ? ORDER BY created_at DESC LIMIT 100`).bind(profile.developer_id).all()).results || [];
  const totals = revenue.reduce((acc, row) => {
    const currency = row.currency;
    acc[currency] ||= { gross: 0, developer: 0, platform: 0 };
    acc[currency].gross += Number(row.gross_amount || 0);
    acc[currency].developer += Number(row.developer_amount || 0);
    acc[currency].platform += Number(row.platform_amount || 0);
    return acc;
  }, {});
  return { profile, balances, revenue, revenueTotals: totals, subscriptions, payouts, generatedAt: now };
}
