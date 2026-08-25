import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateSplit,
  buildBalancedRevenueJournal,
  canTransitionPayout,
  normalizeRevenueEvent,
  transitionBalance,
  validateSplitRule,
} from '../src/services/monetization.js';

const standardRule = {
  splits: [
    { accountKey: 'platform', basisPoints: 2000 },
    { accountKey: 'developer', basisPoints: 7500 },
    { accountKey: 'affiliate', basisPoints: 500 },
  ],
};

test('split rules must total exactly 10000 basis points', () => {
  assert.equal(validateSplitRule(standardRule), standardRule);
  assert.throws(
    () => validateSplitRule({ splits: [{ accountKey: 'platform', basisPoints: 9999 }] }),
    /total 10000/,
  );
});

test('split allocation preserves every minor unit deterministically', () => {
  const result = allocateSplit(101, {
    splits: [
      { accountKey: 'platform', basisPoints: 5000 },
      { accountKey: 'developer', basisPoints: 5000 },
    ],
  });

  assert.deepEqual(result, [
    { accountKey: 'platform', basisPoints: 5000, amountMinor: 51 },
    { accountKey: 'developer', basisPoints: 5000, amountMinor: 50 },
  ]);
  assert.equal(result.reduce((sum, item) => sum + item.amountMinor, 0), 101);
});

test('revenue journal is balanced and rejects mismatched allocations', () => {
  const journal = buildBalancedRevenueJournal({
    eventId: 'evt_1',
    source: 'SUBSCRIPTION',
    grossAmountMinor: 3000,
    currency: 'cny',
    clearingAccountId: 'psp:clearing:cny',
    allocations: [
      { accountId: 'platform:revenue:cny', amountMinor: 600 },
      { accountId: 'developer:42:pending:cny', amountMinor: 2400 },
    ],
  });

  assert.equal(journal.totalDebitsMinor, 3000);
  assert.equal(journal.totalCreditsMinor, 3000);
  assert.equal(journal.currency, 'CNY');
  assert.equal(journal.entries.filter((entry) => entry.direction === 'debit').length, 1);
  assert.equal(journal.entries.filter((entry) => entry.direction === 'credit').length, 2);

  assert.throws(
    () => buildBalancedRevenueJournal({
      eventId: 'evt_bad',
      source: 'PURCHASE',
      grossAmountMinor: 100,
      currency: 'USD',
      clearingAccountId: 'psp:clearing:usd',
      allocations: [{ accountId: 'developer:1:pending:usd', amountMinor: 99 }],
    }),
    /must equal gross amount/,
  );
});

test('balance lifecycle supports pending to available to reserved to paid without overdraft', () => {
  let balance = transitionBalance(
    { pending: 0, available: 0, reserved: 0, paid: 0 },
    { from: null, to: 'pending', amountMinor: 10000 },
  );
  balance = transitionBalance(balance, { from: 'pending', to: 'available', amountMinor: 10000 });
  balance = transitionBalance(balance, { from: 'available', to: 'reserved', amountMinor: 8000 });
  balance = transitionBalance(balance, { from: 'reserved', to: 'paid', amountMinor: 8000 });

  assert.deepEqual(balance, { pending: 0, available: 2000, reserved: 0, paid: 8000 });
  assert.throws(
    () => transitionBalance(balance, { from: 'available', to: 'reserved', amountMinor: 2001 }),
    /insufficient available balance/,
  );
});

test('payout state machine prevents unsafe state skipping', () => {
  assert.equal(canTransitionPayout('requested', 'reviewing'), true);
  assert.equal(canTransitionPayout('reviewing', 'processing'), true);
  assert.equal(canTransitionPayout('processing', 'paid'), true);
  assert.equal(canTransitionPayout('requested', 'paid'), false);
  assert.equal(canTransitionPayout('paid', 'processing'), false);
});

test('revenue events normalize source, currency, and require idempotency', () => {
  const event = normalizeRevenueEvent({
    eventId: 'evt_demo',
    idempotencyKey: 'alipay:trade:abc',
    source: 'subscription',
    scopeType: 'miniapp',
    scopeId: 'global-donation',
    grossAmountMinor: 3000,
    currency: 'cny',
    developerId: 'developer-1',
  });

  assert.equal(event.source, 'SUBSCRIPTION');
  assert.equal(event.currency, 'CNY');
  assert.equal(event.grossAmountMinor, 3000);
  assert.throws(
    () => normalizeRevenueEvent({ source: 'AD_CLICK', scopeType: 'miniapp', scopeId: 'x', grossAmountMinor: 1, currency: 'USD' }),
    /idempotencyKey is required/,
  );
});
