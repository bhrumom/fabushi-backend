import assert from 'node:assert/strict';
import test from 'node:test';

import { generateToken } from '../auth-utils.js';
import {
  handleCheckPurchaseEntitlement,
  handleQueryAlipayOrder,
} from '../src/handlers/payment.js';

const env = { JWT_SECRET: 'payment-products-test-secret' };

test('alipay order query returns a success envelope and asset product type', async () => {
  const db = {
    async getOrder(orderId) {
      return {
        order_id: orderId,
        username: 'bhrum108',
        plan: 'zen_buddha_asset',
        amount: '33.00',
        status: 'PAID',
        created_at: '2026-05-31T00:00:00.000Z',
      };
    },
  };

  const response = await handleQueryAlipayOrder(
    new Request('https://example.com/api/alipay/query-order?orderId=ORDER_1'),
    env,
    db,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.orderId, 'ORDER_1');
  assert.equal(body.userId, 'bhrum108');
  assert.equal(body.productType, 'asset_unlock');
  assert.equal(body.status, 'PAID');
});

test('paid asset entitlement is granted from completed purchase history', async () => {
  const token = await generateToken('bhrum108', env);
  const calls = [];
  const db = {
    async hasCompletedPurchase(username, productId) {
      calls.push({ username, productId });
      return username === 'bhrum108' && productId === 'zen_buddha_asset';
    },
  };

  const response = await handleCheckPurchaseEntitlement(
    new Request(
      'https://example.com/api/purchases/entitlement?product=zen_buddha_asset',
      { headers: { Authorization: `Bearer ${token}` } },
    ),
    env,
    db,
  );
  const body = await response.json();

  assert.deepEqual(calls, [
    { username: 'bhrum108', productId: 'zen_buddha_asset' },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.product, 'zen_buddha_asset');
  assert.equal(body.unlocked, true);
});
