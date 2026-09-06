import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';

const workspace = process.env.GITHUB_WORKSPACE
  ? resolve(process.env.GITHUB_WORKSPACE)
  : resolve(new URL('../../..', import.meta.url).pathname);
const root = join(workspace, 'third_party/mahayana/mahayana-rs/mahayana-platform-worker');
const migrations = join(root, 'migrations');

function text(path) {
  return readFileSync(path, 'utf8');
}

test('Global Dharma sells exactly the server-authoritative monthly and lifetime prayer-wheel products', () => {
  const seed = text(join(migrations, '0009_global_dharma_dynamic_fiat_seed.sql'));
  assert.match(seed, /prod\.global-dharma\.local-prayer-wheel\.monthly/);
  assert.match(seed, /prod\.global-dharma\.local-prayer-wheel\.lifetime/);
  assert.match(seed, /local-prayer-wheel\.monthly/);
  assert.match(seed, /local-prayer-wheel\.lifetime/);
  assert.match(seed, /3000/);
  assert.match(seed, /108000/);
  assert.match(seed, /2592000/);
  assert.match(seed, /'subscription'/);
  assert.match(seed, /'digital_durable'/);
  assert.match(seed, /'web_provider'.*'active'/s);
  assert.match(seed, /'apple_advanced_commerce'.*'pending_configuration'/s);
  assert.match(seed, /'google_play'.*'pending_configuration'/s);
});

test('forward migration normalizes the real host capability and preserves 30-day subscription semantics', () => {
  const repair = text(join(migrations, '0013_global_dharma_paid_capability_gate.sql'));
  for (const table of [
    'products',
    'payment_product_catalog',
    'payment_intents',
    'monetization_subscriptions',
    'entitlements',
  ]) {
    assert.match(repair, new RegExp(`(?:UPDATE|FROM) ${table}`));
  }
  assert.match(repair, /local\.prayer-wheel\.start/g);
  assert.match(repair, /expires_at = granted_at \+ 2592000/);
  assert.doesNotMatch(repair, /amount\s*=\s*3000|amount\s*=\s*108000/);
});

test('canonical entitlement route evaluates subscription lifecycle and active provider rails', () => {
  const policy = text(join(root, 'src/capability_access.rs'));
  const commerce = text(join(root, 'src/worker_api/commerce.rs'));
  assert.match(policy, /subscription_expiry_unknown/);
  assert.match(policy, /subscription_expired/);
  assert.match(policy, /subscription_inactive/);
  assert.match(policy, /active_durable_entitlement/);
  assert.match(policy, /apple_advanced_commerce.*apple_in_app_purchase/s);
  assert.match(policy, /google_play.*google_play_billing/s);
  assert.match(commerce, /evaluate_entitlement_access/);
  assert.match(commerce, /payment_provider_bindings/);
  assert.match(commerce, /sync_state = 'active'/);
  assert.match(commerce, /"purchaseOptions"/);
  assert.match(commerce, /"allowed": allowed/);
});

test('canonical Fabushi Pay enforces order and PaymentIntent idempotency instead of trusting a Mini App purchase flag', () => {
  const commerce = text(join(root, 'src/worker_api/commerce.rs'));
  const payment = text(join(root, 'src/payment_api.rs'));
  assert.match(commerce, /order_by_idempotency/);
  assert.match(commerce, /buyer_user_id = \?1 AND idempotency_key = \?2/);
  assert.match(payment, /payment_by_idempotency/);
  assert.match(payment, /idempotency key was reused with different payment semantics/);
  assert.match(payment, /INSERT INTO payment_intents/);
  assert.match(payment, /ON CONFLICT\(buyer_user_id, idempotency_key\) DO NOTHING/);
});

test('canonical provider callback inbox deduplicates events and only grants entitlement after succeeded capture', () => {
  const payment = text(join(root, 'src/payment_api.rs'));
  assert.match(payment, /claim_webhook_event/);
  assert.match(payment, /INSERT OR IGNORE INTO payment_webhook_events/);
  assert.match(payment, /provider, event_id, payload_sha256/);
  assert.match(payment, /mark_webhook_processed/);
  assert.match(payment, /INSERT OR IGNORE INTO entitlements/);
  assert.match(payment, /FROM payment_intents WHERE payment_id = \?5 AND status = 'succeeded'/);
});

test('full provider refund revokes the active prayer-wheel entitlement and refunded order', () => {
  const payment = text(join(root, 'src/payment_api.rs'));
  assert.match(payment, /refundSucceeded/);
  assert.match(payment, /apply_refund/);
  assert.match(payment, /next_status == "refunded"/);
  assert.match(payment, /UPDATE entitlements SET status = 'revoked', revoked_at = \?1 WHERE order_id = \?2 AND status = 'active'/);
  assert.match(payment, /UPDATE orders SET status = 'refunded'/);
});

test('purchase restore is an authenticated server-side reread of canonical orders', () => {
  const commerce = text(join(root, 'src/worker_api/commerce.rs'));
  assert.match(commerce, /pub\(super\) async fn purchases_restore/);
  assert.match(commerce, /let user_id = authenticated_user\(&request, &context\.env\)\?/);
  assert.match(commerce, /purchases_response\(&context\.env, &user_id\)\.await/);
  assert.match(commerce, /FROM orders WHERE buyer_user_id = \?1 ORDER BY created_at DESC/);
});
