import { verifyToken } from '../../auth-utils.js';
import { jsonResponse } from '../utils/response.js';
import { isAdminUser } from '../utils/helpers.js';
import { platformDb, syncPaymentRevenueEvent } from '../services/monetization-platform.js';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function requireAdmin(request, env, db) {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return { response: jsonResponse({ error: '未提供认证信息' }, 401) };
  const claims = await verifyToken(authorization.slice(7), env);
  if (!claims) return { response: jsonResponse({ error: '认证失败' }, 401) };
  let user = null;
  if (claims.userId != null && db?.getUserById) user = await db.getUserById(claims.userId);
  if (!user && claims.username && db?.getUser) user = await db.getUser(claims.username);
  if (!user || !isAdminUser(user, env)) return { response: jsonResponse({ error: '需要管理员权限' }, 403) };
  return { user, claims };
}

function platformFee(amount, basisPoints) {
  return Math.floor((Number(amount) * Number(basisPoints)) / 10000);
}

async function syncRefundRevenueEvents(database, now) {
  const rows = (await database.prepare(`
    SELECT r.refund_id, r.payment_id, r.amount, r.currency, r.created_at,
           p.mini_app_id, p.developer_id, p.user_id, p.platform_fee_bps, p.status AS payment_status
      FROM fabushi_payment_refunds r
      JOIN payment_intents p ON p.payment_id = r.payment_id
     WHERE r.status = 'succeeded'
     ORDER BY r.payment_id ASC, r.created_at ASC, r.refund_id ASC
  `).all()).results || [];
  const cumulative = new Map();
  let inserted = 0;
  for (const row of rows) {
    const key = String(row.payment_id);
    const before = cumulative.get(key) || 0;
    const after = before + Number(row.amount);
    cumulative.set(key, after);
    const platformAmount = platformFee(after, row.platform_fee_bps) - platformFee(before, row.platform_fee_bps);
    const developerAmount = Number(row.amount) - platformAmount;
    const sourceId = `refund:${row.refund_id}`;
    const result = await database.prepare(`
      INSERT OR IGNORE INTO monetization_revenue_events
        (revenue_event_id, source_kind, source_id, payment_id, mini_app_id, developer_id,
         customer_user_id, gross_amount, platform_amount, developer_amount, currency,
         split_rule_id, status, metadata_json, occurred_at, created_at)
      VALUES (?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'posted', ?, ?, ?)
    `).bind(
      `revenue:${sourceId}`,
      sourceId,
      row.payment_id,
      row.mini_app_id,
      row.developer_id,
      row.user_id,
      Number(row.amount),
      platformAmount,
      developerAmount,
      row.currency,
      JSON.stringify({ direction: 'reversal', refundId: row.refund_id }),
      Number(row.created_at || now),
      now,
    ).run();
    if (Number(result?.meta?.changes || 0) > 0) inserted += 1;
    if (row.payment_status === 'refunded') {
      await database.prepare(`
        UPDATE monetization_revenue_events SET status = 'reversed'
         WHERE source_id = ? AND source_kind IN ('payment','subscription')
      `).bind(`payment:${row.payment_id}`).run();
    }
  }
  return { scanned: rows.length, inserted };
}

async function reconcileSubscriptions(database, now) {
  const expired = (await database.prepare(`
    SELECT subscription_id, user_id, product_id, entitlement_capability
      FROM monetization_subscriptions
     WHERE status IN ('trialing','active','past_due')
       AND current_period_end IS NOT NULL AND current_period_end <= ?
  `).bind(now).all()).results || [];
  for (const row of expired) {
    await database.batch([
      database.prepare(`UPDATE monetization_subscriptions
        SET status = 'expired', updated_at = ? WHERE subscription_id = ?`)
        .bind(now, row.subscription_id),
      database.prepare(`UPDATE entitlements
        SET status = 'expired', expires_at = COALESCE(expires_at, ?)
        WHERE user_id = ? AND product_id = ? AND capability = ? AND status = 'active'`)
        .bind(now, row.user_id, row.product_id, row.entitlement_capability),
    ]);
  }
  return { expired: expired.length };
}

async function reconcilePayoutRequests(database, now) {
  const rows = (await database.prepare(`
    SELECT r.request_id, r.status AS request_status, p.status AS payout_status
      FROM monetization_payout_requests r
      JOIN developer_payouts p ON p.payout_id = r.canonical_payout_id
     WHERE r.status IN ('approved','submitted')
  `).all()).results || [];
  let updated = 0;
  for (const row of rows) {
    let status = 'submitted';
    if (row.payout_status === 'paid') status = 'paid';
    else if (row.payout_status === 'failed') status = 'failed';
    else if (row.payout_status === 'cancelled') status = 'cancelled';
    if (status !== row.request_status) {
      const result = await database.prepare(`UPDATE monetization_payout_requests
        SET status = ?, updated_at = ? WHERE request_id = ?`)
        .bind(status, now, row.request_id).run();
      updated += Number(result?.meta?.changes || 0);
    }
  }
  return { scanned: rows.length, updated };
}

async function anomalyReport(database) {
  const paymentWithoutJournal = await database.prepare(`
    SELECT COUNT(*) AS count
      FROM payment_intents p
     WHERE p.status IN ('succeeded','partially_refunded','refunded')
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries j
          WHERE j.reference_type = 'payment' AND j.reference_id = p.payment_id AND j.state = 'posted'
       )
  `).first();
  const paymentRevenueWithoutPayment = await database.prepare(`
    SELECT COUNT(*) AS count
      FROM monetization_revenue_events r
     WHERE r.payment_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM payment_intents p WHERE p.payment_id = r.payment_id)
  `).first();
  const adRevenueWithoutJournal = await database.prepare(`
    SELECT COUNT(*) AS count
      FROM monetization_revenue_events r
     WHERE r.source_kind = 'advertising'
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries j
          WHERE j.reference_type = 'ad_revenue' AND j.reference_id = r.source_id AND j.state = 'posted'
       )
  `).first();
  const unbalancedEntries = await database.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT j.entry_id
        FROM journal_entries j
        JOIN journal_lines l ON l.entry_id = j.entry_id
       WHERE j.state = 'posted'
       GROUP BY j.entry_id, l.currency
      HAVING SUM(l.amount) <> 0
    )
  `).first();
  return {
    successfulPaymentsWithoutPostedJournal: Number(paymentWithoutJournal?.count || 0),
    revenueEventsWithoutPayment: Number(paymentRevenueWithoutPayment?.count || 0),
    adRevenueWithoutPostedJournal: Number(adRevenueWithoutJournal?.count || 0),
    unbalancedPostedJournalCurrencies: Number(unbalancedEntries?.count || 0),
  };
}

export async function handleAdminMonetizationReconcile(request, env, db) {
  try {
    const auth = await requireAdmin(request, env, db);
    if (auth.response) return auth.response;
    const database = platformDb(env);
    const now = nowSeconds();
    const payments = (await database.prepare(`
      SELECT p.payment_id
        FROM payment_intents p
       WHERE p.status IN ('succeeded','partially_refunded','refunded')
         AND NOT EXISTS (
           SELECT 1 FROM monetization_revenue_events r
            WHERE r.source_id = 'payment:' || p.payment_id
         )
       ORDER BY p.created_at ASC LIMIT 500
    `).all()).results || [];
    let paymentEventsInserted = 0;
    for (const row of payments) {
      const result = await syncPaymentRevenueEvent(database, row.payment_id, now);
      if (result) paymentEventsInserted += 1;
    }
    const refunds = await syncRefundRevenueEvents(database, now);
    const subscriptions = await reconcileSubscriptions(database, now);
    const payouts = await reconcilePayoutRequests(database, now);
    const anomalies = await anomalyReport(database);
    const healthy = Object.values(anomalies).every((value) => value === 0);
    return jsonResponse({
      ok: healthy,
      reconciledAt: now,
      payments: { scanned: payments.length, inserted: paymentEventsInserted },
      refunds,
      subscriptions,
      payouts,
      anomalies,
    }, healthy ? 200 : 409);
  } catch (error) {
    console.error('Monetization reconciliation failed:', error?.message || error);
    return jsonResponse({ error: 'Monetization reconciliation failed' }, 500);
  }
}
