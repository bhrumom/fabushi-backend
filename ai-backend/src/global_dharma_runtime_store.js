import crypto from 'node:crypto';

export const GLOBAL_DHARMA_RUNTIME_PROTOCOL = 'fabushi.miniapp.runtime.v1';
export const GLOBAL_DHARMA_MINIAPP_ID = 'global-dharma';

const clone = (value) => JSON.parse(JSON.stringify(value));

export function defaultGlobalDharmaRuntimeState() {
  return {
    running: false,
    loops: 0,
    sent: 0,
    logs: [],
    mode: null,
    pendingContent: null,
  };
}

function normalizedAccountId(value) {
  const accountId = String(value ?? '').trim();
  if (!accountId) throw new Error('accountId is required for Mini App runtime state');
  return accountId;
}

function normalizedOperationId(value) {
  const operationId = String(value ?? '').trim();
  if (!operationId) return crypto.randomUUID();
  if (operationId.length > 160) throw new Error('operationId exceeds 160 characters');
  return operationId;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function fingerprint(toolName, args) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonical({ toolName, args })))
    .digest('hex');
}

function parseJson(value, fallback) {
  try { return JSON.parse(String(value ?? '')); } catch { return fallback; }
}

export class GlobalDharmaRuntimeStore {
  constructor({ accountSyncStore, now = () => Date.now() } = {}) {
    if (!accountSyncStore?.db || typeof accountSyncStore.recordEvent !== 'function') {
      throw new Error('GlobalDharmaRuntimeStore requires AccountSyncStore');
    }
    this.accountSyncStore = accountSyncStore;
    this.db = accountSyncStore.db;
    this.now = now;
    this.#ensureSchema();
    this.#prepare();
  }

  #ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS miniapp_runtime_state (
        account_id TEXT NOT NULL,
        mini_app_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (account_id, mini_app_id)
      );
      CREATE TABLE IF NOT EXISTS miniapp_runtime_operations (
        account_id TEXT NOT NULL,
        mini_app_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        cursor TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (account_id, mini_app_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_miniapp_runtime_operations_account_app_created
        ON miniapp_runtime_operations (account_id, mini_app_id, created_at_ms DESC);
    `);
  }

  #prepare() {
    this.s = {
      getState: this.db.prepare(`
        SELECT revision, state_json AS stateJson, updated_at_ms AS updatedAtMs
        FROM miniapp_runtime_state
        WHERE account_id = ? AND mini_app_id = ? LIMIT 1
      `),
      upsertState: this.db.prepare(`
        INSERT INTO miniapp_runtime_state
          (account_id, mini_app_id, revision, state_json, updated_at_ms)
        VALUES (@accountId, @miniAppId, @revision, @stateJson, @updatedAtMs)
        ON CONFLICT(account_id, mini_app_id) DO UPDATE SET
          revision = excluded.revision,
          state_json = excluded.state_json,
          updated_at_ms = excluded.updated_at_ms
      `),
      getOperation: this.db.prepare(`
        SELECT operation_id AS operationId, tool_name AS toolName, args_hash AS argsHash,
          result_json AS resultJson, revision, cursor, created_at_ms AS createdAtMs
        FROM miniapp_runtime_operations
        WHERE account_id = ? AND mini_app_id = ? AND operation_id = ? LIMIT 1
      `),
      insertOperation: this.db.prepare(`
        INSERT INTO miniapp_runtime_operations
          (account_id, mini_app_id, operation_id, tool_name, args_hash, result_json, revision, cursor, created_at_ms)
        VALUES (@accountId, @miniAppId, @operationId, @toolName, @argsHash, @resultJson, @revision, @cursor, @createdAtMs)
      `),
    };
  }

  snapshot(accountIdInput, miniAppId = GLOBAL_DHARMA_MINIAPP_ID) {
    const accountId = normalizedAccountId(accountIdInput);
    const row = this.s.getState.get(accountId, miniAppId);
    const state = row ? parseJson(row.stateJson, defaultGlobalDharmaRuntimeState()) : defaultGlobalDharmaRuntimeState();
    return {
      protocol: GLOBAL_DHARMA_RUNTIME_PROTOCOL,
      miniAppId,
      revision: Number(row?.revision ?? 0),
      cursor: this.accountSyncStore.currentCursor(accountId),
      state,
      updatedAtMs: Number(row?.updatedAtMs ?? 0),
      replayed: false,
    };
  }

  runMutation(accountIdInput, {
    miniAppId = GLOBAL_DHARMA_MINIAPP_ID,
    operationId: operationIdInput,
    toolName,
    args = {},
    mutate,
  } = {}) {
    const accountId = normalizedAccountId(accountIdInput);
    const operationId = normalizedOperationId(operationIdInput);
    const normalizedToolName = String(toolName ?? '').trim();
    if (!normalizedToolName) throw new Error('toolName is required for Mini App runtime mutation');
    if (typeof mutate !== 'function') throw new Error('mutate callback is required for Mini App runtime mutation');
    const argsForHash = clone(args ?? {});
    delete argsForHash.operationId;
    delete argsForHash.operation_id;
    const argsHash = fingerprint(normalizedToolName, argsForHash);
    const now = this.now();

    const transaction = this.db.transaction(() => {
      const existing = this.s.getOperation.get(accountId, miniAppId, operationId);
      if (existing) {
        if (existing.toolName !== normalizedToolName || existing.argsHash !== argsHash) {
          const error = new Error('operationId was already used for a different Mini App tool call');
          error.code = 'MINIAPP_IDEMPOTENCY_CONFLICT';
          error.statusCode = 409;
          throw error;
        }
        const replay = parseJson(existing.resultJson, null);
        if (!replay) throw new Error('stored Mini App operation receipt is corrupt');
        if (replay.structuredContent?.runtime) replay.structuredContent.runtime.replayed = true;
        return replay;
      }

      const currentRow = this.s.getState.get(accountId, miniAppId);
      const state = currentRow
        ? parseJson(currentRow.stateJson, defaultGlobalDharmaRuntimeState())
        : defaultGlobalDharmaRuntimeState();
      const toolResult = mutate(state);
      if (!toolResult || typeof toolResult !== 'object') throw new Error('Mini App mutation must return an MCP result object');
      state.logs = Array.isArray(state.logs) ? state.logs.slice(-500) : [];
      const revision = Number(currentRow?.revision ?? 0) + 1;
      this.s.upsertState.run({
        accountId,
        miniAppId,
        revision,
        stateJson: JSON.stringify(state),
        updatedAtMs: now,
      });
      const event = this.accountSyncStore.recordEvent(accountId, 'miniapp.runtime.updated', miniAppId, {
        miniAppId,
        revision,
        tool: normalizedToolName,
        operationId,
        state,
      });
      const runtime = {
        protocol: GLOBAL_DHARMA_RUNTIME_PROTOCOL,
        miniAppId,
        revision,
        cursor: event.cursor,
        state: clone(state),
        updatedAtMs: now,
        replayed: false,
      };
      const completed = {
        ...toolResult,
        structuredContent: {
          ...(toolResult.structuredContent ?? {}),
          runtime,
          operationId,
        },
      };
      this.s.insertOperation.run({
        accountId,
        miniAppId,
        operationId,
        toolName: normalizedToolName,
        argsHash,
        resultJson: JSON.stringify(completed),
        revision,
        cursor: event.cursor,
        createdAtMs: now,
      });
      return completed;
    });

    return transaction();
  }

  difference(accountIdInput, cursor = null, limit = 200, miniAppId = GLOBAL_DHARMA_MINIAPP_ID) {
    const accountId = normalizedAccountId(accountIdInput);
    const delta = this.accountSyncStore.sync(accountId, cursor, limit);
    if (delta.mode === 'snapshot') {
      return {
        protocol: GLOBAL_DHARMA_RUNTIME_PROTOCOL,
        miniAppId,
        mode: 'snapshot',
        reason: delta.reason,
        cursor: delta.cursor,
        hasMore: false,
        runtime: this.snapshot(accountId, miniAppId),
        events: [],
      };
    }
    return {
      protocol: GLOBAL_DHARMA_RUNTIME_PROTOCOL,
      miniAppId,
      mode: 'difference',
      cursor: delta.cursor,
      hasMore: delta.hasMore,
      runtime: null,
      events: delta.events
        .filter((event) => event.type === 'miniapp.runtime.updated' && event.entityId === miniAppId)
        .map((event) => ({
          sequence: event.sequence,
          cursor: event.cursor,
          occurredAtMs: event.occurredAtMs,
          revision: Number(event.payload?.revision ?? 0),
          tool: String(event.payload?.tool ?? ''),
          operationId: String(event.payload?.operationId ?? ''),
          state: clone(event.payload?.state ?? defaultGlobalDharmaRuntimeState()),
        })),
    };
  }
}
