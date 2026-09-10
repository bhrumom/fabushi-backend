import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { handlePaymentStatus, handleStripeCheckout, handleStripeWebhook } from '../src/handlers/payment-gateways.js';

const SECRET = 'fabushi-payment-webhook-secret-for-tests';
const PAYMENT = {
  payment_id: '7f6f2d21-1f8b-4a8b-a9e4-2d6b8d0f7a11',
  user_id: 'user-42',
  mini_app_id: 'global-dharma',
  sku: 'local.prayer-wheel.lifetime',
  product_kind: 'digital_durable',
  rail: 'web_provider',
  currency: 'CNY',
  amount: 108000,
  status: 'requires_action',
};

function mockDatabase(payment = PAYMENT) {
  return {
    batch: async () => [],
    prepare() {
      return {
        bind() {
          return { first: async () => payment };
        },
      };
    },
  };
}

function checkoutToken(payment = PAYMENT) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    paymentId: payment.payment_id,
    userId: payment.user_id,
    exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function stripeSignature(body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

test('Stripe checkout uses canonical server amount as dynamic price_data', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = '';
  try {
    globalThis.fetch = async (_url, options) => {
      requestBody = String(options.body);
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_fabushi' }), { status: 200 });
    };
    const request = new Request(`https://api.ombhrum.com/api/pay/checkout?paymentId=${PAYMENT.payment_id}&checkoutToken=${checkoutToken()}`);
    const response = await handleStripeCheckout(request, {
      PLATFORM_DB: mockDatabase(),
      FABUSHI_PAY_WEBHOOK_SECRET: SECRET,
      STRIPE_SECRET_KEY: 'sk_test_only_for_unit_test',
      FRONTEND_URL: 'https://flutter.ombhrum.com',
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_fabushi');
    assert.match(requestBody, /line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=108000/);
    assert.doesNotMatch(requestBody, /payment_method_types/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('payment status endpoint verifies the short-lived checkout token', async () => {
  const request = new Request(`https://api.ombhrum.com/api/pay/status?paymentId=${PAYMENT.payment_id}&checkoutToken=${checkoutToken()}`);
  const response = await handlePaymentStatus(request, {
    PLATFORM_DB: mockDatabase(),
    FABUSHI_PAY_WEBHOOK_SECRET: SECRET,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    paymentId: PAYMENT.payment_id,
    status: PAYMENT.status,
    currency: PAYMENT.currency,
    amount: PAYMENT.amount,
  });
});

test('Stripe webhook forwards a verified paid session to canonical Pay', async () => {
  const originalFetch = globalThis.fetch;
  let forwarded;
  try {
    globalThis.fetch = async (url, options) => {
      forwarded = { url, options, body: JSON.parse(String(options.body)) };
      return new Response('{"ok":true}', { status: 200 });
    };
    const event = {
      id: 'evt_fabushi_test',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: {
        id: 'cs_test_fabushi',
        client_reference_id: PAYMENT.payment_id,
        metadata: { paymentId: PAYMENT.payment_id },
        payment_status: 'paid',
        amount_total: PAYMENT.amount,
        currency: 'cny',
      } },
    };
    const body = JSON.stringify(event);
    const response = await handleStripeWebhook(
      new Request('https://api.ombhrum.com/api/pay/stripe/webhook', {
        method: 'POST',
        headers: { 'Stripe-Signature': stripeSignature(body) },
        body,
      }),
      {
        PLATFORM_DB: mockDatabase(),
        FABUSHI_PAY_URL: 'https://pay.ombhrum.com',
        FABUSHI_PAY_WEBHOOK_SECRET: SECRET,
        STRIPE_WEBHOOK_SECRET: SECRET,
        STRIPE_LIVEMODE: 'false',
      },
    );
    assert.equal(response.status, 200);
    assert.equal(forwarded.url, 'https://pay.ombhrum.com/v1/pay/providers/stripe/webhook');
    assert.deepEqual(forwarded.body, {
      eventId: 'stripe:evt_fabushi_test',
      eventType: 'paymentSucceeded',
      paymentId: PAYMENT.payment_id,
      providerReference: 'cs_test_fabushi',
      amount: PAYMENT.amount,
      occurredAt: event.created,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
