import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { generateToken } from '../auth-utils.js';
import {
  handleCreateAlipayOrder,
  handleCheckPurchaseEntitlement,
  handleQueryAlipayOrder,
} from '../src/handlers/payment.js';
import { DatabaseService } from '../src/services/database.js';

const env = { JWT_SECRET: 'payment-products-test-secret' };
const TEST_ALIPAY_PRIVATE_KEY = readFileSync(
  new URL('../test_private_key_pkcs8.pem', import.meta.url),
  'utf8',
);

function createD1Mock({ columnsByTable = {}, firstResult = null } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) {
          this.params = params;
          return this;
        },
        async all() {
          const pragmaMatch = sql.match(/PRAGMA table_info\(([^)]+)\)/);
          if (pragmaMatch) {
            return {
              results: (columnsByTable[pragmaMatch[1]] || []).map((name) => ({ name })),
            };
          }
          return { results: [] };
        },
        async first() {
          calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: this.params });
          return firstResult;
        },
        async run() {
          calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: this.params });
          return { success: true };
        },
      };
      return statement;
    },
  };
}

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
    async getUser(username) {
      return { id: 22, username, email: 'bhrum108@example.com' };
    },
    async hasCompletedPurchase(username, productId, userId) {
      calls.push({ username, productId, userId });
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
    { username: 'bhrum108', productId: 'zen_buddha_asset', userId: 22 },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.product, 'zen_buddha_asset');
  assert.equal(body.unlocked, true);
});

test('create Alipay order resolves stale token username through userId', async () => {
  const token = await generateToken({ id: 55, username: 'stale_desktop_name' }, env);
  const createdOrders = [];
  const db = {
    async getUserById(userId) {
      assert.equal(userId, 55);
      return { id: 55, username: 'real_paid_user', email: 'real@example.com' };
    },
    async getUser() {
      throw new Error('username fallback should not be used when userId exists');
    },
    async createOrder(order) {
      createdOrders.push(order);
    },
  };

  const response = await handleCreateAlipayOrder(
    new Request('https://example.com/api/alipay/create-order', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan: 'monthly', platform: 'app' }),
    }),
    {
      ...env,
      ALIPAY_APP_ID: 'test-app-id',
      ALIPAY_PRIVATE_KEY: TEST_ALIPAY_PRIVATE_KEY,
      WORKER_URL: 'https://api.example.com',
    },
    db,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(createdOrders.length, 1);
  assert.equal(createdOrders[0].username, 'real_paid_user');
  assert.equal(createdOrders[0].accountUserId, 55);
  assert.match(createdOrders[0].orderId, /^MEMBER_real_paid_user_/);
});

test('createOrder writes username into legacy orders.user_id when username columns are absent', async () => {
  const rawDb = createD1Mock({
    columnsByTable: {
      orders: [
        'order_id',
        'user_id',
        'plan',
        'amount',
        'original_amount',
        'is_admin_order',
        'status',
        'platform',
        'created_at',
        'updated_at',
      ],
    },
  });
  const db = new DatabaseService(rawDb);

  await db.createOrder({
    orderId: 'MEMBER_bhrum108_1',
    username: 'bhrum108',
    plan: 'zen_buddha_asset',
    amount: '33.00',
    originalAmount: '33.00',
    isAdminOrder: false,
    status: 'PENDING',
    platform: 'app',
    createdAt: '2026-05-31T00:00:00.000Z',
  });

  const insert = rawDb.calls.find((call) => call.sql.startsWith('INSERT INTO orders'));
  assert.match(insert.sql, /order_id, user_id, plan/);
  assert.doesNotMatch(insert.sql, /username/);
  assert.deepEqual(insert.params.slice(0, 4), [
    'MEMBER_bhrum108_1',
    'bhrum108',
    'zen_buddha_asset',
    '33.00',
  ]);
});

test('hasCompletedPurchase supports legacy purchase_history without username column', async () => {
  const rawDb = createD1Mock({
    columnsByTable: {
      purchase_history: ['id', 'user_id', 'plan', 'status'],
    },
    firstResult: { id: 'purchase_1' },
  });
  const db = new DatabaseService(rawDb);

  const unlocked = await db.hasCompletedPurchase('bhrum108', 'zen_buddha_asset', 22);

  const select = rawDb.calls.find((call) => call.sql.startsWith('SELECT id FROM purchase_history'));
  assert.equal(unlocked, true);
  assert.match(select.sql, /user_id IN \(\?, \?\)/);
  assert.doesNotMatch(select.sql, /username =/);
  assert.deepEqual(select.params, ['zen_buddha_asset', 'bhrum108', '22']);
});
