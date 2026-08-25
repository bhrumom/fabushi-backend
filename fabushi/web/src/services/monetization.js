const BALANCE_BUCKETS = new Set(['pending', 'available', 'reserved', 'paid']);

export function assertMinorUnits(value, name = 'amountMinor') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer minor-unit amount`);
  }
  return value;
}

export function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('currency must be an ISO-4217 style 3-letter code');
  return currency;
}

export function validateSplitRule(rule) {
  if (!rule || !Array.isArray(rule.splits) || rule.splits.length === 0) {
    throw new TypeError('split rule must include at least one split');
  }

  let totalBps = 0;
  const seen = new Set();
  for (const split of rule.splits) {
    const accountKey = String(split?.accountKey || '').trim();
    if (!accountKey) throw new TypeError('split accountKey is required');
    if (seen.has(accountKey)) throw new TypeError(`duplicate split accountKey: ${accountKey}`);
    seen.add(accountKey);

    const basisPoints = Number(split.basisPoints);
    if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
      throw new TypeError('split basisPoints must be an integer between 0 and 10000');
    }
    totalBps += basisPoints;
  }

  if (totalBps !== 10000) throw new RangeError(`split basis points must total 10000; got ${totalBps}`);
  return rule;
}

export function allocateSplit(amountMinor, rule) {
  assertMinorUnits(amountMinor);
  validateSplitRule(rule);

  const allocations = rule.splits.map((split, index) => {
    const raw = amountMinor * split.basisPoints;
    const floor = Math.floor(raw / 10000);
    const remainder = raw % 10000;
    return {
      accountKey: split.accountKey,
      basisPoints: split.basisPoints,
      amountMinor: floor,
      remainder,
      index,
    };
  });

  let allocated = allocations.reduce((sum, item) => sum + item.amountMinor, 0);
  let remainderUnits = amountMinor - allocated;
  const remainderOrder = [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remainderUnits; index += 1) {
    remainderOrder[index % remainderOrder.length].amountMinor += 1;
  }

  return allocations.map(({ remainder, index, ...item }) => item);
}

export function buildBalancedRevenueJournal({
  eventId,
  source,
  grossAmountMinor,
  currency,
  clearingAccountId,
  allocations,
}) {
  assertMinorUnits(grossAmountMinor, 'grossAmountMinor');
  const normalizedCurrency = normalizeCurrency(currency);
  if (!eventId) throw new TypeError('eventId is required');
  if (!source) throw new TypeError('source is required');
  if (!clearingAccountId) throw new TypeError('clearingAccountId is required');
  if (!Array.isArray(allocations) || allocations.length === 0) throw new TypeError('allocations are required');

  const creditTotal = allocations.reduce((sum, item) => sum + assertMinorUnits(item.amountMinor), 0);
  if (creditTotal !== grossAmountMinor) {
    throw new RangeError(`journal allocations must equal gross amount: ${creditTotal} != ${grossAmountMinor}`);
  }

  const entries = [
    {
      accountId: clearingAccountId,
      direction: 'debit',
      amountMinor: grossAmountMinor,
      currency: normalizedCurrency,
    },
    ...allocations.map((item) => ({
      accountId: item.accountId,
      direction: 'credit',
      amountMinor: item.amountMinor,
      currency: normalizedCurrency,
    })),
  ];

  return {
    eventId,
    eventType: source,
    currency: normalizedCurrency,
    totalDebitsMinor: grossAmountMinor,
    totalCreditsMinor: creditTotal,
    entries,
  };
}

export function transitionBalance(balance, transition) {
  const next = {
    pending: assertMinorUnits(balance?.pending ?? 0, 'pending'),
    available: assertMinorUnits(balance?.available ?? 0, 'available'),
    reserved: assertMinorUnits(balance?.reserved ?? 0, 'reserved'),
    paid: assertMinorUnits(balance?.paid ?? 0, 'paid'),
  };
  const amountMinor = assertMinorUnits(transition?.amountMinor, 'amountMinor');
  const from = transition?.from ?? null;
  const to = transition?.to ?? null;

  if (from !== null && !BALANCE_BUCKETS.has(from)) throw new TypeError(`invalid source balance bucket: ${from}`);
  if (to !== null && !BALANCE_BUCKETS.has(to)) throw new TypeError(`invalid destination balance bucket: ${to}`);
  if (from === null && to === null) throw new TypeError('a balance transition needs a source or destination bucket');
  if (from === to && from !== null) return next;

  if (from !== null) {
    if (next[from] < amountMinor) throw new RangeError(`insufficient ${from} balance`);
    next[from] -= amountMinor;
  }
  if (to !== null) next[to] += amountMinor;
  return next;
}

export function canTransitionPayout(from, to) {
  const transitions = {
    requested: new Set(['reviewing', 'cancelled', 'failed']),
    reviewing: new Set(['processing', 'cancelled', 'failed']),
    processing: new Set(['paid', 'failed']),
    paid: new Set(),
    failed: new Set(),
    cancelled: new Set(),
  };
  return Boolean(transitions[from]?.has(to));
}

export function normalizeRevenueEvent(input) {
  if (!input?.idempotencyKey) throw new TypeError('idempotencyKey is required');
  if (!input?.source) throw new TypeError('source is required');
  if (!input?.scopeType || !input?.scopeId) throw new TypeError('scopeType and scopeId are required');
  return {
    eventId: input.eventId || crypto.randomUUID(),
    idempotencyKey: String(input.idempotencyKey),
    source: String(input.source).toUpperCase(),
    sourceId: input.sourceId ?? null,
    scopeType: String(input.scopeType),
    scopeId: String(input.scopeId),
    grossAmountMinor: assertMinorUnits(input.grossAmountMinor, 'grossAmountMinor'),
    currency: normalizeCurrency(input.currency),
    developerId: input.developerId ?? null,
    miniappId: input.miniappId ?? null,
    botId: input.botId ?? null,
    customerId: input.customerId ?? null,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    occurredAt: input.occurredAt || new Date().toISOString(),
  };
}
