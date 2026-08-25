import {
  buildBalancedRevenueJournal,
  normalizeRevenueEvent,
} from './monetization.js';

function nowIso() {
  return new Date().toISOString();
}

export async function findRevenueEventByIdempotency(db, idempotencyKey) {
  return await db.prepare(`
    SELECT event_id, idempotency_key, source, source_id, scope_type, scope_id,
           gross_amount_minor, currency, developer_id, miniapp_id, bot_id,
           customer_id, status, metadata_json, occurred_at, created_at
      FROM monetization_revenue_events
     WHERE idempotency_key = ?
  `).bind(idempotencyKey).first();
}

export async function recordRevenueEvent({
  db,
  input,
  clearingAccount,
  allocations,
}) {
  if (!db?.prepare || !db?.batch) throw new TypeError('D1-compatible db binding is required');
  const event = normalizeRevenueEvent(input);
  const existing = await findRevenueEventByIdempotency(db, event.idempotencyKey);
  if (existing) return { eventId: existing.event_id, duplicate: true };

  if (!clearingAccount?.accountId) throw new TypeError('clearingAccount.accountId is required');
  if (!Array.isArray(allocations) || allocations.length === 0) throw new TypeError('allocations are required');

  const journalId = `journal_${event.eventId}`;
  const journal = buildBalancedRevenueJournal({
    eventId: event.eventId,
    source: event.source,
    grossAmountMinor: event.grossAmountMinor,
    currency: event.currency,
    clearingAccountId: clearingAccount.accountId,
    allocations: allocations.map((item) => ({
      accountId: item.account.accountId,
      amountMinor: item.amountMinor,
    })),
  });
  const createdAt = nowIso();
  const accounts = [clearingAccount, ...allocations.map((item) => item.account)];
  const statements = [];

  for (const account of accounts) {
    if (!account?.accountId || !account?.ownerType || !account?.ownerId || !account?.bucket) {
      throw new TypeError('each account requires accountId, ownerType, ownerId, and bucket');
    }
    statements.push(
      db.prepare(`
        INSERT OR IGNORE INTO monetization_accounts
          (account_id, owner_type, owner_id, bucket, currency, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `).bind(
        account.accountId,
        account.ownerType,
        account.ownerId,
        account.bucket,
        event.currency,
        createdAt,
        createdAt,
      ),
    );
  }

  statements.push(
    db.prepare(`
      INSERT INTO monetization_revenue_events
        (event_id, idempotency_key, source, source_id, scope_type, scope_id,
         gross_amount_minor, currency, developer_id, miniapp_id, bot_id, customer_id,
         status, metadata_json, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?, ?)
    `).bind(
      event.eventId,
      event.idempotencyKey,
      event.source,
      event.sourceId,
      event.scopeType,
      event.scopeId,
      event.grossAmountMinor,
      event.currency,
      event.developerId,
      event.miniappId,
      event.botId,
      event.customerId,
      JSON.stringify(event.metadata),
      event.occurredAt,
      createdAt,
    ),
    db.prepare(`
      INSERT INTO monetization_journals
        (journal_id, event_id, event_type, currency, total_debits_minor, total_credits_minor,
         status, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'posted', '{}', ?)
    `).bind(
      journalId,
      event.eventId,
      journal.eventType,
      journal.currency,
      journal.totalDebitsMinor,
      journal.totalCreditsMinor,
      createdAt,
    ),
  );

  for (const [index, entry] of journal.entries.entries()) {
    statements.push(
      db.prepare(`
        INSERT INTO monetization_entries
          (entry_id, journal_id, account_id, direction, amount_minor, currency, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        `${journalId}:entry:${index + 1}`,
        journalId,
        entry.accountId,
        entry.direction,
        entry.amountMinor,
        entry.currency,
        createdAt,
      ),
    );
  }

  for (const allocation of allocations) {
    if (allocation.account.bucket !== 'pending') continue;
    statements.push(
      db.prepare(`
        INSERT INTO monetization_balances
          (account_id, pending_minor, available_minor, reserved_minor, paid_minor, updated_at)
        VALUES (?, ?, 0, 0, 0, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          pending_minor = pending_minor + excluded.pending_minor,
          updated_at = excluded.updated_at
      `).bind(allocation.account.accountId, allocation.amountMinor, createdAt),
    );
  }

  try {
    await db.batch(statements);
    return { eventId: event.eventId, journalId, duplicate: false };
  } catch (error) {
    const raced = await findRevenueEventByIdempotency(db, event.idempotencyKey);
    if (raced) return { eventId: raced.event_id, duplicate: true };
    throw error;
  }
}
