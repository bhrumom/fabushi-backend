import crypto from 'node:crypto';

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const RESERVED_NAMESPACES = new Set(['fabushi']);
const SECRET_FIELD = /(token|secret|password|api[-_]?key|credential|authorization)/i;

function json(value) {
  return JSON.stringify(value ?? {});
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(String(value ?? ''));
  } catch {
    return fallback;
  }
}

export class ExtensionPublisherStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtensionPublisherStoreError';
    this.code = code;
  }
}

function namespaceName(value) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase();
  if (!NAMESPACE_PATTERN.test(normalized)) {
    throw new ExtensionPublisherStoreError('INVALID_NAMESPACE', 'namespace is invalid');
  }
  return normalized;
}

function claimableNamespace(value) {
  const normalized = namespaceName(value);
  if (RESERVED_NAMESPACES.has(normalized)) {
    throw new ExtensionPublisherStoreError('RESERVED_NAMESPACE', 'namespace is reserved');
  }
  return normalized;
}

function accountId(value, field = 'accountId') {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 240) {
    throw new ExtensionPublisherStoreError('INVALID_ACCOUNT', `${field} is invalid`);
  }
  return normalized;
}

function displayName(value, fallback) {
  const normalized = String(value ?? fallback ?? '').trim();
  if (!normalized || normalized.length > 160) {
    throw new ExtensionPublisherStoreError('INVALID_DISPLAY_NAME', 'displayName is invalid');
  }
  return normalized;
}

function assertNoSecrets(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSecrets(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) {
      throw new ExtensionPublisherStoreError('SECRET_AUDIT_FIELD', `audit payload contains forbidden field ${path}.${key}`);
    }
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function publicNamespace(row) {
  if (!row) return null;
  return {
    namespace: row.namespace,
    displayName: row.displayName,
    status: row.status,
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
    transferPending: Boolean(row.pendingTargetAccountId),
  };
}

export class ExtensionPublisherStore {
  constructor({ db, now = () => Date.now() } = {}) {
    if (!db) throw new Error('ExtensionPublisherStore requires the existing Marketplace SQLite connection');
    this.db = db;
    this.now = now;
    this.#ensureSchema();
    this.#prepare();
  }

  #ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_publisher_namespaces (
        namespace TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        owner_account_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        pending_transfer_id TEXT,
        pending_target_account_id TEXT,
        pending_transfer_created_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_extension_publisher_namespaces_owner
        ON extension_publisher_namespaces (owner_account_id, namespace);

      CREATE TABLE IF NOT EXISTS extension_publisher_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_account_id TEXT NOT NULL,
        target_account_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        occurred_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_extension_publisher_audit_namespace_sequence
        ON extension_publisher_audit (namespace, sequence ASC);
    `);
  }

  #prepare() {
    this.s = {
      get: this.db.prepare(`
        SELECT namespace, display_name AS displayName, owner_account_id AS ownerAccountId,
          status, pending_transfer_id AS pendingTransferId,
          pending_target_account_id AS pendingTargetAccountId,
          pending_transfer_created_at_ms AS pendingTransferCreatedAtMs,
          created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
        FROM extension_publisher_namespaces
        WHERE namespace = ?
        LIMIT 1
      `),
      insert: this.db.prepare(`
        INSERT INTO extension_publisher_namespaces (
          namespace, display_name, owner_account_id, status,
          created_at_ms, updated_at_ms
        ) VALUES (
          @namespace, @displayName, @ownerAccountId, 'active',
          @createdAtMs, @updatedAtMs
        )
      `),
      updateDisplay: this.db.prepare(`
        UPDATE extension_publisher_namespaces
        SET display_name = @displayName, updated_at_ms = @updatedAtMs
        WHERE namespace = @namespace
      `),
      proposeTransfer: this.db.prepare(`
        UPDATE extension_publisher_namespaces
        SET pending_transfer_id = @transferId,
          pending_target_account_id = @targetAccountId,
          pending_transfer_created_at_ms = @createdAtMs,
          updated_at_ms = @updatedAtMs
        WHERE namespace = @namespace
      `),
      acceptTransfer: this.db.prepare(`
        UPDATE extension_publisher_namespaces
        SET owner_account_id = @targetAccountId,
          pending_transfer_id = NULL,
          pending_target_account_id = NULL,
          pending_transfer_created_at_ms = NULL,
          updated_at_ms = @updatedAtMs
        WHERE namespace = @namespace
      `),
      clearTransfer: this.db.prepare(`
        UPDATE extension_publisher_namespaces
        SET pending_transfer_id = NULL,
          pending_target_account_id = NULL,
          pending_transfer_created_at_ms = NULL,
          updated_at_ms = @updatedAtMs
        WHERE namespace = @namespace
      `),
      auditInsert: this.db.prepare(`
        INSERT INTO extension_publisher_audit (
          namespace, action, actor_account_id, target_account_id,
          payload_json, occurred_at_ms
        ) VALUES (
          @namespace, @action, @actorAccountId, @targetAccountId,
          @payloadJson, @occurredAtMs
        )
      `),
      auditList: this.db.prepare(`
        SELECT sequence, namespace, action,
          actor_account_id AS actorAccountId,
          target_account_id AS targetAccountId,
          payload_json AS payloadJson,
          occurred_at_ms AS occurredAtMs
        FROM extension_publisher_audit
        WHERE namespace = ?
        ORDER BY sequence ASC
      `),
      listOwned: this.db.prepare(`
        SELECT namespace, display_name AS displayName, owner_account_id AS ownerAccountId,
          status, pending_transfer_id AS pendingTransferId,
          pending_target_account_id AS pendingTargetAccountId,
          pending_transfer_created_at_ms AS pendingTransferCreatedAtMs,
          created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
        FROM extension_publisher_namespaces
        WHERE owner_account_id = ?
        ORDER BY namespace ASC
      `),
    };
  }

  #owned(namespace, actorAccountId) {
    const normalized = claimableNamespace(namespace);
    const row = this.s.get.get(normalized);
    if (!row) throw new ExtensionPublisherStoreError('NAMESPACE_NOT_FOUND', 'namespace was not found');
    if (row.ownerAccountId !== accountId(actorAccountId)) {
      throw new ExtensionPublisherStoreError('NAMESPACE_FORBIDDEN', 'namespace is owned by another account');
    }
    return row;
  }

  #audit({ namespace, action, actorAccountId, targetAccountId = null, payload = {}, occurredAtMs }) {
    assertNoSecrets(payload);
    this.s.auditInsert.run({
      namespace,
      action,
      actorAccountId,
      targetAccountId,
      payloadJson: json(payload),
      occurredAtMs,
    });
  }

  getPublic(namespace) {
    const normalized = namespaceName(namespace);
    return publicNamespace(this.s.get.get(normalized));
  }

  listOwned(actorAccountId) {
    const owner = accountId(actorAccountId);
    return this.s.listOwned.all(owner).map(publicNamespace);
  }

  create({ namespace, displayName: requestedDisplayName, ownerAccountId }) {
    const normalized = claimableNamespace(namespace);
    const owner = accountId(ownerAccountId);
    if (this.s.get.get(normalized)) {
      throw new ExtensionPublisherStoreError('NAMESPACE_CONFLICT', 'namespace is already claimed');
    }
    const now = this.now();
    const record = {
      namespace: normalized,
      displayName: displayName(requestedDisplayName, normalized),
      ownerAccountId: owner,
      createdAtMs: now,
      updatedAtMs: now,
    };
    const transaction = this.db.transaction(() => {
      this.s.insert.run(record);
      this.#audit({
        namespace: normalized,
        action: 'namespace.created',
        actorAccountId: owner,
        payload: { displayName: record.displayName },
        occurredAtMs: now,
      });
    });
    transaction();
    return this.getPublic(normalized);
  }

  update({ namespace, actorAccountId, displayName: requestedDisplayName }) {
    const current = this.#owned(namespace, actorAccountId);
    const nextDisplayName = displayName(requestedDisplayName, current.displayName);
    if (nextDisplayName === current.displayName) return publicNamespace(current);
    const now = this.now();
    const transaction = this.db.transaction(() => {
      this.s.updateDisplay.run({
        namespace: current.namespace,
        displayName: nextDisplayName,
        updatedAtMs: now,
      });
      this.#audit({
        namespace: current.namespace,
        action: 'namespace.updated',
        actorAccountId: current.ownerAccountId,
        payload: { displayName: nextDisplayName },
        occurredAtMs: now,
      });
    });
    transaction();
    return this.getPublic(current.namespace);
  }

  proposeTransfer({ namespace, actorAccountId, targetAccountId }) {
    const current = this.#owned(namespace, actorAccountId);
    const target = accountId(targetAccountId, 'targetAccountId');
    if (target === current.ownerAccountId) {
      throw new ExtensionPublisherStoreError('TRANSFER_SAME_OWNER', 'target account already owns namespace');
    }
    const now = this.now();
    const transferId = crypto.randomUUID();
    const transaction = this.db.transaction(() => {
      this.s.proposeTransfer.run({
        namespace: current.namespace,
        transferId,
        targetAccountId: target,
        createdAtMs: now,
        updatedAtMs: now,
      });
      this.#audit({
        namespace: current.namespace,
        action: 'namespace.transfer.proposed',
        actorAccountId: current.ownerAccountId,
        targetAccountId: target,
        payload: { transferId },
        occurredAtMs: now,
      });
    });
    transaction();
    return {
      namespace: current.namespace,
      transferId,
      targetAccountId: target,
      createdAtMs: now,
    };
  }

  acceptTransfer({ namespace, actorAccountId, transferId }) {
    const normalized = claimableNamespace(namespace);
    const actor = accountId(actorAccountId);
    const current = this.s.get.get(normalized);
    if (!current) throw new ExtensionPublisherStoreError('NAMESPACE_NOT_FOUND', 'namespace was not found');
    if (!current.pendingTransferId || !current.pendingTargetAccountId) {
      throw new ExtensionPublisherStoreError('TRANSFER_NOT_PENDING', 'namespace has no pending transfer');
    }
    if (current.pendingTargetAccountId !== actor) {
      throw new ExtensionPublisherStoreError('TRANSFER_FORBIDDEN', 'only the target account may accept transfer');
    }
    if (String(transferId ?? '').trim() !== current.pendingTransferId) {
      throw new ExtensionPublisherStoreError('TRANSFER_MISMATCH', 'transfer id does not match pending transfer');
    }
    const previousOwner = current.ownerAccountId;
    const now = this.now();
    const transaction = this.db.transaction(() => {
      this.s.acceptTransfer.run({
        namespace: normalized,
        targetAccountId: actor,
        updatedAtMs: now,
      });
      this.#audit({
        namespace: normalized,
        action: 'namespace.transfer.accepted',
        actorAccountId: actor,
        targetAccountId: actor,
        payload: { transferId: current.pendingTransferId, previousOwnerAccountId: previousOwner },
        occurredAtMs: now,
      });
    });
    transaction();
    return this.getPublic(normalized);
  }

  cancelTransfer({ namespace, actorAccountId }) {
    const current = this.#owned(namespace, actorAccountId);
    if (!current.pendingTransferId) {
      throw new ExtensionPublisherStoreError('TRANSFER_NOT_PENDING', 'namespace has no pending transfer');
    }
    const now = this.now();
    const transaction = this.db.transaction(() => {
      this.s.clearTransfer.run({ namespace: current.namespace, updatedAtMs: now });
      this.#audit({
        namespace: current.namespace,
        action: 'namespace.transfer.cancelled',
        actorAccountId: current.ownerAccountId,
        targetAccountId: current.pendingTargetAccountId,
        payload: { transferId: current.pendingTransferId },
        occurredAtMs: now,
      });
    });
    transaction();
    return this.getPublic(current.namespace);
  }

  audit(namespace) {
    const normalized = namespaceName(namespace);
    return this.s.auditList.all(normalized).map((row) => ({
      sequence: Number(row.sequence),
      namespace: row.namespace,
      action: row.action,
      actorAccountId: row.actorAccountId,
      targetAccountId: row.targetAccountId,
      payload: parseJson(row.payloadJson, {}),
      occurredAtMs: Number(row.occurredAtMs),
    }));
  }
}
