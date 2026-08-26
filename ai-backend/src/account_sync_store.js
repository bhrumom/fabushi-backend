import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import Database from 'better-sqlite3';

const ACCOUNT_SYNC_PROTOCOL = 'fabushi.account.sync.v1';
const DEFAULT_EVENT_RETENTION = 10_000;
const CLOUD_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CLOUD_KEYS_PER_APP = 1024;
const MAX_CLOUD_VALUE_BYTES = 4096;

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value ?? '')); } catch { return fallback; }
}

function positiveLimit(value, fallback = 200, max = 1000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(numeric)));
}

function normalizeAccountId(value) {
  const accountId = String(value ?? '').trim();
  if (!accountId) throw new Error('accountId is required');
  return accountId;
}

function normalizeMiniAppId(value) {
  const id = String(value ?? '').trim().toLocaleLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new Error('invalid Mini App id');
  return id;
}

function normalizeBotProfile(value, fallbackId = '') {
  const source = value && typeof value === 'object' ? value : {};
  const id = String(source.id ?? fallbackId ?? '').trim().toLocaleLowerCase();
  if (!id || id.length > 160) throw new Error('invalid Bot id');
  return {
    id,
    username: String(source.username ?? '').trim().slice(0, 80),
    displayName: String(source.displayName ?? source.name ?? id).trim().slice(0, 160),
    description: String(source.description ?? '').trim().slice(0, 1000),
    conversationId: String(source.conversationId ?? '').trim().slice(0, 240),
    managedBy: String(source.managedBy ?? '').trim().slice(0, 120),
    mainApp: source.mainApp !== false,
    naturalLanguage: source.naturalLanguage !== false,
    menuButton: source.menuButton && typeof source.menuButton === 'object' ? source.menuButton : undefined,
  };
}

function encodeCursor(sequence) {
  return `as1:${Math.max(0, Number(sequence) || 0)}`;
}

function decodeCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const match = text.match(/^as1:(\d+)$/);
  if (!match) return Number.NaN;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : Number.NaN;
}

export class AccountSyncStore {
  constructor({ db = null, dbPath = null, dataDir = null, now = () => Date.now(), eventRetention = DEFAULT_EVENT_RETENTION } = {}) {
    this.now = now;
    this.eventRetention = Math.max(16, Number(eventRetention) || DEFAULT_EVENT_RETENTION);
    this.ownsDb = !db;
    const root = dataDir ?? process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
    const resolvedPath = dbPath ?? process.env.SQLITE_PATH ?? path.join(root, 'dacheng-ai.sqlite');
    if (!db) {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
      this.db = new Database(resolvedPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    } else {
      this.db = db;
    }
    this.#ensureSchema();
    this.#prepare();
  }

  close() {
    if (this.ownsDb) this.db.close();
  }

  #ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_sync_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        occurred_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_account_sync_events_account_sequence
        ON account_sync_events (account_id, sequence ASC);

      CREATE TABLE IF NOT EXISTS account_sync_state (
        account_id TEXT PRIMARY KEY,
        floor_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_miniapp_installs (
        account_id TEXT NOT NULL,
        mini_app_id TEXT NOT NULL,
        version TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_json TEXT NOT NULL,
        installed_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (account_id, mini_app_id)
      );
      CREATE INDEX IF NOT EXISTS idx_account_miniapp_installs_account_updated
        ON account_miniapp_installs (account_id, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS account_bot_memberships (
        account_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        added_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (account_id, bot_id, source, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_account_bot_memberships_account_bot
        ON account_bot_memberships (account_id, bot_id, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS miniapp_cloud_storage (
        account_id TEXT NOT NULL,
        mini_app_id TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        value TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (account_id, mini_app_id, storage_key)
      );
      CREATE INDEX IF NOT EXISTS idx_miniapp_cloud_storage_account_app
        ON miniapp_cloud_storage (account_id, mini_app_id, updated_at_ms ASC);
    `);
  }

  #prepare() {
    this.s = {
      insertEvent: this.db.prepare(`
        INSERT INTO account_sync_events (account_id, event_type, entity_id, payload_json, occurred_at_ms)
        VALUES (@accountId, @eventType, @entityId, @payloadJson, @occurredAtMs)
      `),
      currentSequence: this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM account_sync_events WHERE account_id = ?'),
      eventCount: this.db.prepare('SELECT COUNT(*) AS count FROM account_sync_events WHERE account_id = ?'),
      retainedMinimum: this.db.prepare('SELECT COALESCE(MIN(sequence), 0) AS sequence FROM account_sync_events WHERE account_id = ?'),
      deleteEventsBefore: this.db.prepare('DELETE FROM account_sync_events WHERE account_id = ? AND sequence < ?'),
      upsertState: this.db.prepare(`
        INSERT INTO account_sync_state (account_id, floor_sequence, updated_at_ms)
        VALUES (@accountId, @floorSequence, @updatedAtMs)
        ON CONFLICT(account_id) DO UPDATE SET
          floor_sequence = MAX(account_sync_state.floor_sequence, excluded.floor_sequence),
          updated_at_ms = excluded.updated_at_ms
      `),
      getState: this.db.prepare('SELECT floor_sequence AS floorSequence FROM account_sync_state WHERE account_id = ? LIMIT 1'),
      eventsAfter: this.db.prepare(`
        SELECT sequence, event_type AS eventType, entity_id AS entityId, payload_json AS payloadJson, occurred_at_ms AS occurredAtMs
        FROM account_sync_events
        WHERE account_id = @accountId AND sequence > @after
        ORDER BY sequence ASC LIMIT @limit
      `),
      getMiniAppInstall: this.db.prepare('SELECT * FROM account_miniapp_installs WHERE account_id = ? AND mini_app_id = ? LIMIT 1'),
      upsertMiniAppInstall: this.db.prepare(`
        INSERT INTO account_miniapp_installs (
          account_id, mini_app_id, version, bot_id, bot_json, installed_at_ms, updated_at_ms
        ) VALUES (@accountId, @miniAppId, @version, @botId, @botJson, @installedAtMs, @updatedAtMs)
        ON CONFLICT(account_id, mini_app_id) DO UPDATE SET
          version = excluded.version,
          bot_id = excluded.bot_id,
          bot_json = excluded.bot_json,
          updated_at_ms = excluded.updated_at_ms
      `),
      deleteMiniAppInstall: this.db.prepare('DELETE FROM account_miniapp_installs WHERE account_id = ? AND mini_app_id = ?'),
      listMiniAppInstalls: this.db.prepare(`
        SELECT mini_app_id AS miniAppId, version, bot_id AS botId, bot_json AS botJson,
          installed_at_ms AS installedAtMs, updated_at_ms AS updatedAtMs
        FROM account_miniapp_installs WHERE account_id = ? ORDER BY installed_at_ms ASC, mini_app_id ASC
      `),
      upsertBotMembership: this.db.prepare(`
        INSERT INTO account_bot_memberships (
          account_id, bot_id, source, source_id, profile_json, added_at_ms, updated_at_ms
        ) VALUES (@accountId, @botId, @source, @sourceId, @profileJson, @addedAtMs, @updatedAtMs)
        ON CONFLICT(account_id, bot_id, source, source_id) DO UPDATE SET
          profile_json = excluded.profile_json,
          updated_at_ms = excluded.updated_at_ms
      `),
      getBotMembership: this.db.prepare(`
        SELECT * FROM account_bot_memberships
        WHERE account_id = ? AND bot_id = ? AND source = ? AND source_id = ? LIMIT 1
      `),
      deleteBotMembership: this.db.prepare(`
        DELETE FROM account_bot_memberships
        WHERE account_id = ? AND bot_id = ? AND source = ? AND source_id = ?
      `),
      listBotMemberships: this.db.prepare(`
        SELECT bot_id AS botId, source, source_id AS sourceId, profile_json AS profileJson,
          added_at_ms AS addedAtMs, updated_at_ms AS updatedAtMs
        FROM account_bot_memberships WHERE account_id = ?
        ORDER BY updated_at_ms DESC, bot_id ASC
      `),
      cloudCount: this.db.prepare('SELECT COUNT(*) AS count FROM miniapp_cloud_storage WHERE account_id = ? AND mini_app_id = ?'),
      getCloudValue: this.db.prepare(`
        SELECT storage_key AS key, value, revision, updated_at_ms AS updatedAtMs
        FROM miniapp_cloud_storage WHERE account_id = ? AND mini_app_id = ? AND storage_key = ? LIMIT 1
      `),
      listCloudValues: this.db.prepare(`
        SELECT storage_key AS key, value, revision, updated_at_ms AS updatedAtMs
        FROM miniapp_cloud_storage WHERE account_id = ? AND mini_app_id = ? ORDER BY storage_key ASC
      `),
      upsertCloudValue: this.db.prepare(`
        INSERT INTO miniapp_cloud_storage (account_id, mini_app_id, storage_key, value, revision, updated_at_ms)
        VALUES (@accountId, @miniAppId, @key, @value, @revision, @updatedAtMs)
        ON CONFLICT(account_id, mini_app_id, storage_key) DO UPDATE SET
          value = excluded.value,
          revision = excluded.revision,
          updated_at_ms = excluded.updated_at_ms
      `),
      deleteCloudValue: this.db.prepare('DELETE FROM miniapp_cloud_storage WHERE account_id = ? AND mini_app_id = ? AND storage_key = ?'),
      listCloudRevisions: this.db.prepare(`
        SELECT mini_app_id AS miniAppId, storage_key AS key, revision, updated_at_ms AS updatedAtMs
        FROM miniapp_cloud_storage WHERE account_id = ? ORDER BY mini_app_id ASC, storage_key ASC
      `),
    };
  }

  #appendEvent(accountId, eventType, entityId, payload, occurredAtMs = this.now()) {
    const result = this.s.insertEvent.run({
      accountId,
      eventType,
      entityId,
      payloadJson: json(payload ?? {}),
      occurredAtMs,
    });
    const sequence = Number(result.lastInsertRowid);
    this.#prune(accountId, occurredAtMs);
    return sequence;
  }

  #prune(accountId, now) {
    const count = Number(this.s.eventCount.get(accountId)?.count ?? 0);
    if (count <= this.eventRetention) return;
    const rows = this.db.prepare(`
      SELECT sequence FROM account_sync_events
      WHERE account_id = ? ORDER BY sequence DESC LIMIT 1 OFFSET ?
    `).all(accountId, this.eventRetention - 1);
    const minimumRetained = Number(rows[0]?.sequence ?? 0);
    if (!minimumRetained) return;
    this.s.deleteEventsBefore.run(accountId, minimumRetained);
    this.s.upsertState.run({ accountId, floorSequence: minimumRetained - 1, updatedAtMs: now });
  }

  installMiniApp(accountIdInput, manifest) {
    const accountId = normalizeAccountId(accountIdInput);
    const miniAppId = normalizeMiniAppId(manifest?.id);
    const version = String(manifest?.version ?? '').trim() || '0';
    const bot = normalizeBotProfile(manifest?.bot, `${miniAppId}-bot`);
    const now = this.now();
    const transaction = this.db.transaction(() => {
      const previous = this.s.getMiniAppInstall.get(accountId, miniAppId);
      this.s.upsertMiniAppInstall.run({
        accountId,
        miniAppId,
        version,
        botId: bot.id,
        botJson: json(bot),
        installedAtMs: Number(previous?.installed_at_ms ?? now),
        updatedAtMs: now,
      });
      const previousBot = this.s.getBotMembership.get(accountId, bot.id, 'miniapp', miniAppId);
      this.s.upsertBotMembership.run({
        accountId,
        botId: bot.id,
        source: 'miniapp',
        sourceId: miniAppId,
        profileJson: json(bot),
        addedAtMs: Number(previousBot?.added_at_ms ?? now),
        updatedAtMs: now,
      });
      const changed = !previous || previous.version !== version || previous.bot_id !== bot.id || previous.bot_json !== json(bot);
      if (changed) {
        this.#appendEvent(accountId, previous ? 'miniapp.updated' : 'miniapp.installed', miniAppId, { miniAppId, version, bot }, now);
      }
      if (!previousBot) this.#appendEvent(accountId, 'bot.added', bot.id, { bot, source: 'miniapp', miniAppId }, now);
      return { added: true, changed, miniAppId, version, bot };
    });
    return transaction();
  }

  removeMiniApp(accountIdInput, miniAppIdInput) {
    const accountId = normalizeAccountId(accountIdInput);
    const miniAppId = normalizeMiniAppId(miniAppIdInput);
    const now = this.now();
    const transaction = this.db.transaction(() => {
      const previous = this.s.getMiniAppInstall.get(accountId, miniAppId);
      if (!previous) return { removed: false, miniAppId };
      this.s.deleteMiniAppInstall.run(accountId, miniAppId);
      const botId = String(previous.bot_id);
      const membership = this.s.getBotMembership.get(accountId, botId, 'miniapp', miniAppId);
      if (membership) this.s.deleteBotMembership.run(accountId, botId, 'miniapp', miniAppId);
      this.#appendEvent(accountId, 'miniapp.removed', miniAppId, { miniAppId, botId }, now);
      if (membership) this.#appendEvent(accountId, 'bot.removed', botId, { botId, source: 'miniapp', miniAppId }, now);
      return { removed: true, miniAppId, botId };
    });
    return transaction();
  }

  listMiniAppInstalls(accountIdInput) {
    const accountId = normalizeAccountId(accountIdInput);
    return this.s.listMiniAppInstalls.all(accountId).map((row) => ({
      ...row,
      bot: parseJson(row.botJson, {}),
      botJson: undefined,
    }));
  }

  addBot(accountIdInput, profile, { source = 'manual', sourceId = 'manual' } = {}) {
    const accountId = normalizeAccountId(accountIdInput);
    const bot = normalizeBotProfile(profile);
    const normalizedSource = String(source || 'manual').trim().slice(0, 40);
    const normalizedSourceId = String(sourceId || normalizedSource).trim().slice(0, 160);
    const now = this.now();
    const previous = this.s.getBotMembership.get(accountId, bot.id, normalizedSource, normalizedSourceId);
    this.s.upsertBotMembership.run({
      accountId,
      botId: bot.id,
      source: normalizedSource,
      sourceId: normalizedSourceId,
      profileJson: json(bot),
      addedAtMs: Number(previous?.added_at_ms ?? now),
      updatedAtMs: now,
    });
    if (!previous || previous.profile_json !== json(bot)) {
      this.#appendEvent(accountId, previous ? 'bot.updated' : 'bot.added', bot.id, {
        bot,
        source: normalizedSource,
        sourceId: normalizedSourceId,
      }, now);
    }
    return { added: true, bot, source: normalizedSource, sourceId: normalizedSourceId };
  }

  removeBot(accountIdInput, botIdInput, { source = 'manual', sourceId = 'manual' } = {}) {
    const accountId = normalizeAccountId(accountIdInput);
    const botId = String(botIdInput ?? '').trim().toLocaleLowerCase();
    if (!botId) throw new Error('Bot id is required');
    const normalizedSource = String(source || 'manual').trim().slice(0, 40);
    const normalizedSourceId = String(sourceId || normalizedSource).trim().slice(0, 160);
    const previous = this.s.getBotMembership.get(accountId, botId, normalizedSource, normalizedSourceId);
    if (!previous) return { removed: false, botId };
    this.s.deleteBotMembership.run(accountId, botId, normalizedSource, normalizedSourceId);
    this.#appendEvent(accountId, 'bot.removed', botId, { botId, source: normalizedSource, sourceId: normalizedSourceId });
    return { removed: true, botId };
  }

  listBots(accountIdInput) {
    const accountId = normalizeAccountId(accountIdInput);
    const grouped = new Map();
    for (const row of this.s.listBotMemberships.all(accountId)) {
      const profile = parseJson(row.profileJson, { id: row.botId });
      const current = grouped.get(row.botId) ?? { bot: profile, sources: [], updatedAtMs: 0 };
      current.sources.push({ source: row.source, sourceId: row.sourceId, addedAtMs: row.addedAtMs });
      if (Number(row.updatedAtMs) >= current.updatedAtMs) {
        current.bot = profile;
        current.updatedAtMs = Number(row.updatedAtMs);
      }
      grouped.set(row.botId, current);
    }
    return [...grouped.values()].sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.bot.id.localeCompare(right.bot.id));
  }

  setCloudValue(accountIdInput, miniAppIdInput, keyInput, valueInput) {
    const accountId = normalizeAccountId(accountIdInput);
    const miniAppId = normalizeMiniAppId(miniAppIdInput);
    const key = String(keyInput ?? '').trim();
    if (!CLOUD_KEY_PATTERN.test(key)) throw new Error('Mini App CloudStorage key must be 1-128 ASCII letters, digits, _ or -');
    const value = String(valueInput ?? '');
    if (Buffer.byteLength(value, 'utf8') > MAX_CLOUD_VALUE_BYTES) throw new Error('Mini App CloudStorage value exceeds 4096 bytes');
    const previous = this.s.getCloudValue.get(accountId, miniAppId, key);
    if (!previous && Number(this.s.cloudCount.get(accountId, miniAppId)?.count ?? 0) >= MAX_CLOUD_KEYS_PER_APP) {
      throw new Error('Mini App CloudStorage exceeds 1024 keys for this account');
    }
    const now = this.now();
    const transaction = this.db.transaction(() => {
      const revision = this.#appendEvent(accountId, 'miniapp.cloud.set', `${miniAppId}:${key}`, { miniAppId, key, value }, now);
      this.s.upsertCloudValue.run({ accountId, miniAppId, key, value, revision, updatedAtMs: now });
      return { key, value, revision, updatedAtMs: now };
    });
    return transaction();
  }

  deleteCloudValue(accountIdInput, miniAppIdInput, keyInput) {
    const accountId = normalizeAccountId(accountIdInput);
    const miniAppId = normalizeMiniAppId(miniAppIdInput);
    const key = String(keyInput ?? '').trim();
    if (!CLOUD_KEY_PATTERN.test(key)) throw new Error('invalid Mini App CloudStorage key');
    const previous = this.s.getCloudValue.get(accountId, miniAppId, key);
    if (!previous) return { deleted: false, key };
    const now = this.now();
    const transaction = this.db.transaction(() => {
      this.s.deleteCloudValue.run(accountId, miniAppId, key);
      const revision = this.#appendEvent(accountId, 'miniapp.cloud.deleted', `${miniAppId}:${key}`, { miniAppId, key }, now);
      return { deleted: true, key, revision, updatedAtMs: now };
    });
    return transaction();
  }

  getCloudValue(accountIdInput, miniAppIdInput, keyInput) {
    const accountId = normalizeAccountId(accountIdInput);
    const miniAppId = normalizeMiniAppId(miniAppIdInput);
    const key = String(keyInput ?? '').trim();
    if (!CLOUD_KEY_PATTERN.test(key)) throw new Error('invalid Mini App CloudStorage key');
    return this.s.getCloudValue.get(accountId, miniAppId, key) ?? null;
  }

  listCloudValues(accountIdInput, miniAppIdInput) {
    const accountId = normalizeAccountId(accountIdInput);
    const miniAppId = normalizeMiniAppId(miniAppIdInput);
    return this.s.listCloudValues.all(accountId, miniAppId);
  }

  recordEvent(accountIdInput, eventTypeInput, entityIdInput, payload = {}) {
    const accountId = normalizeAccountId(accountIdInput);
    const eventType = String(eventTypeInput ?? '').trim();
    const entityId = String(entityIdInput ?? '').trim();
    if (!eventType || !entityId) throw new Error('account sync event type and entity id are required');
    const sequence = this.#appendEvent(accountId, eventType, entityId, payload);
    return { sequence, cursor: encodeCursor(sequence) };
  }

  currentCursor(accountIdInput) {
    const accountId = normalizeAccountId(accountIdInput);
    return encodeCursor(Number(this.s.currentSequence.get(accountId)?.sequence ?? 0));
  }

  sync(accountIdInput, cursorInput = null, limitInput = 200) {
    const accountId = normalizeAccountId(accountIdInput);
    const limit = positiveLimit(limitInput);
    const current = Number(this.s.currentSequence.get(accountId)?.sequence ?? 0);
    const floor = Number(this.s.getState.get(accountId)?.floorSequence ?? 0);
    const requested = decodeCursor(cursorInput);
    const snapshot = (reason) => ({
      protocol: ACCOUNT_SYNC_PROTOCOL,
      mode: 'snapshot',
      reason,
      cursor: encodeCursor(current),
      hasMore: false,
      snapshot: {
        miniApps: this.listMiniAppInstalls(accountId),
        bots: this.listBots(accountId),
        cloudRevisions: this.s.listCloudRevisions.all(accountId),
      },
      events: [],
    });

    if (requested === null) return snapshot('initial');
    if (!Number.isFinite(requested)) return snapshot('invalid-cursor');
    if (requested > current) return snapshot('cursor-ahead');
    if (requested < floor) return snapshot('cursor-expired');

    const rows = this.s.eventsAfter.all({ accountId, after: requested, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const events = page.map((row) => ({
      sequence: Number(row.sequence),
      cursor: encodeCursor(row.sequence),
      type: row.eventType,
      entityId: row.entityId,
      payload: parseJson(row.payloadJson, {}),
      occurredAtMs: Number(row.occurredAtMs),
    }));
    const checkpoint = hasMore
      ? Number(page.at(-1)?.sequence ?? requested)
      : current;
    return {
      protocol: ACCOUNT_SYNC_PROTOCOL,
      mode: 'difference',
      cursor: encodeCursor(checkpoint),
      hasMore,
      snapshot: null,
      events,
    };
  }
}

export { ACCOUNT_SYNC_PROTOCOL, CLOUD_KEY_PATTERN, MAX_CLOUD_KEYS_PER_APP, MAX_CLOUD_VALUE_BYTES, encodeCursor, decodeCursor };
