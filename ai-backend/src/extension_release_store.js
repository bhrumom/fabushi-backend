import crypto from 'node:crypto';

import {
  ExtensionRegistryError,
  normalizeExtensionEntry,
} from './extension_registry.js';

const RELEASE_STATES = new Set(['draft', 'pending_review', 'approved', 'rejected', 'revoked']);
const SAFE_COMPONENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(String(value ?? ''));
  } catch {
    return fallback;
  }
}

function component(value, field) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase();
  if (!SAFE_COMPONENT.test(normalized)) {
    throw new ExtensionReleaseStoreError('INVALID_RELEASE_IDENTITY', `${field} is invalid`);
  }
  return normalized;
}

function version(value) {
  const normalized = String(value ?? '').trim();
  if (!VERSION_PATTERN.test(normalized)) {
    throw new ExtensionReleaseStoreError('INVALID_RELEASE_VERSION', 'version must use semantic versioning');
  }
  return normalized;
}

function releaseKey({ kind, namespace, name, version: releaseVersion }) {
  return {
    kind: component(kind, 'kind'),
    namespace: component(namespace, 'namespace'),
    name: component(name, 'name'),
    version: version(releaseVersion),
  };
}

function digestDescriptor(descriptor) {
  return crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
}

function parseSemver(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) return Number(left[index]) - Number(right[index]);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index].localeCompare(right[index]);
  }
  return 0;
}

function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return String(left).localeCompare(String(right));
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] - b[field];
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function publicRelease(row, { includeDescriptor = true } = {}) {
  if (!row) return null;
  return {
    kind: row.kind,
    namespace: row.namespace,
    name: row.name,
    version: row.version,
    state: row.state,
    descriptorDigest: row.descriptorDigest,
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
    submittedAtMs: row.submittedAtMs == null ? null : Number(row.submittedAtMs),
    reviewedAtMs: row.reviewedAtMs == null ? null : Number(row.reviewedAtMs),
    revokedAtMs: row.revokedAtMs == null ? null : Number(row.revokedAtMs),
    reviewNotes: row.reviewNotes || '',
    ...(includeDescriptor ? { descriptor: parseJson(row.descriptorJson, null) } : {}),
  };
}

export class ExtensionReleaseStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtensionReleaseStoreError';
    this.code = code;
  }
}

export class ExtensionReleaseStore {
  constructor({ db, publisherStore, now = () => Date.now() } = {}) {
    if (!db) throw new Error('ExtensionReleaseStore requires existing Marketplace SQLite connection');
    if (!publisherStore) throw new Error('ExtensionReleaseStore requires ExtensionPublisherStore');
    this.db = db;
    this.publisherStore = publisherStore;
    this.now = now;
    this.artifactStore = null;
    this.signingStore = null;
    this.#ensureSchema();
    this.#prepare();
  }

  #ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_releases (
        kind TEXT NOT NULL,
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        state TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        descriptor_digest TEXT NOT NULL,
        publisher_account_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        submitted_at_ms INTEGER,
        reviewed_at_ms INTEGER,
        revoked_at_ms INTEGER,
        reviewer TEXT,
        review_notes TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (kind, namespace, name, version)
      );

      CREATE INDEX IF NOT EXISTS idx_extension_releases_public
        ON extension_releases (state, kind, namespace, name, version);

      CREATE INDEX IF NOT EXISTS idx_extension_releases_publisher
        ON extension_releases (publisher_account_id, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS extension_release_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        occurred_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_extension_release_audit_key_sequence
        ON extension_release_audit (kind, namespace, name, version, sequence ASC);
    `);
  }

  #prepare() {
    const select = `
      SELECT kind, namespace, name, version, state,
        descriptor_json AS descriptorJson,
        descriptor_digest AS descriptorDigest,
        publisher_account_id AS publisherAccountId,
        created_at_ms AS createdAtMs,
        updated_at_ms AS updatedAtMs,
        submitted_at_ms AS submittedAtMs,
        reviewed_at_ms AS reviewedAtMs,
        revoked_at_ms AS revokedAtMs,
        reviewer, review_notes AS reviewNotes
      FROM extension_releases
    `;
    this.s = {
      get: this.db.prepare(`${select}
        WHERE kind = ? AND namespace = ? AND name = ? AND version = ?
        LIMIT 1
      `),
      insert: this.db.prepare(`
        INSERT INTO extension_releases (
          kind, namespace, name, version, state, descriptor_json,
          descriptor_digest, publisher_account_id,
          created_at_ms, updated_at_ms
        ) VALUES (
          @kind, @namespace, @name, @version, 'draft', @descriptorJson,
          @descriptorDigest, @publisherAccountId,
          @createdAtMs, @updatedAtMs
        )
      `),
      submit: this.db.prepare(`
        UPDATE extension_releases
        SET state = 'pending_review', submitted_at_ms = @submittedAtMs,
          updated_at_ms = @updatedAtMs
        WHERE kind = @kind AND namespace = @namespace AND name = @name AND version = @version
      `),
      review: this.db.prepare(`
        UPDATE extension_releases
        SET state = @state, reviewed_at_ms = @reviewedAtMs,
          reviewer = @reviewer, review_notes = @reviewNotes,
          updated_at_ms = @updatedAtMs
        WHERE kind = @kind AND namespace = @namespace AND name = @name AND version = @version
      `),
      revoke: this.db.prepare(`
        UPDATE extension_releases
        SET state = 'revoked', revoked_at_ms = @revokedAtMs,
          reviewer = @reviewer, review_notes = @reviewNotes,
          updated_at_ms = @updatedAtMs
        WHERE kind = @kind AND namespace = @namespace AND name = @name AND version = @version
      `),
      listNamespace: this.db.prepare(`${select}
        WHERE namespace = ?
        ORDER BY updated_at_ms DESC, name ASC, kind ASC, version DESC
      `),
      listApproved: this.db.prepare(`${select}
        WHERE state = 'approved'
        ORDER BY namespace ASC, name ASC, kind ASC, version ASC
      `),
      auditInsert: this.db.prepare(`
        INSERT INTO extension_release_audit (
          kind, namespace, name, version, action, actor, payload_json, occurred_at_ms
        ) VALUES (
          @kind, @namespace, @name, @version, @action, @actor, @payloadJson, @occurredAtMs
        )
      `),
      auditList: this.db.prepare(`
        SELECT sequence, action, actor, payload_json AS payloadJson,
          occurred_at_ms AS occurredAtMs
        FROM extension_release_audit
        WHERE kind = ? AND namespace = ? AND name = ? AND version = ?
        ORDER BY sequence ASC
      `),
    };
  }

  setArtifactStore(artifactStore) {
    this.artifactStore = artifactStore;
    return this;
  }

  setSigningStore(signingStore) {
    this.signingStore = signingStore;
    return this;
  }

  getRelease(rawKey) {
    const key = releaseKey(rawKey);
    return publicRelease(this.#row(key));
  }

  #row(key) {
    return this.s.get.get(key.kind, key.namespace, key.name, key.version);
  }

  #require(key) {
    const row = this.#row(key);
    if (!row) throw new ExtensionReleaseStoreError('RELEASE_NOT_FOUND', 'release was not found');
    return row;
  }

  #requirePublisher(row, actorAccountId) {
    this.publisherStore.assertOwned(row.namespace, actorAccountId);
  }

  #audit(key, action, actor, payload, occurredAtMs) {
    this.s.auditInsert.run({
      ...key,
      action,
      actor: String(actor),
      payloadJson: json(payload ?? {}),
      occurredAtMs,
    });
  }

  createDraft({ actorAccountId, descriptor: input }) {
    const namespace = component(input?.identity?.namespace, 'identity.namespace');
    this.publisherStore.assertOwned(namespace, actorAccountId);
    const sanitized = normalizeExtensionEntry({
      ...input,
      identity: {
        namespace,
        name: input?.identity?.name,
        kind: input?.identity?.kind,
      },
      origin: 'public',
      trustDomain: 'catalog-authorized',
      publisher: {
        id: namespace,
        displayName: input?.publisher?.displayName ?? namespace,
        verified: false,
        verificationEvidence: [],
      },
      release: {
        ...input?.release,
        revoked: false,
      },
    });
    const key = releaseKey({
      kind: sanitized.identity.kind,
      namespace: sanitized.identity.namespace,
      name: sanitized.identity.name,
      version: sanitized.release.version,
    });
    if (this.#row(key)) {
      throw new ExtensionReleaseStoreError('RELEASE_CONFLICT', 'release version already exists and is immutable');
    }
    const descriptorDigest = digestDescriptor(sanitized);
    const now = this.now();
    const transaction = this.db.transaction(() => {
      this.s.insert.run({
        ...key,
        descriptorJson: json(sanitized),
        descriptorDigest,
        publisherAccountId: String(actorAccountId),
        createdAtMs: now,
        updatedAtMs: now,
      });
      this.#audit(key, 'release.created', actorAccountId, { descriptorDigest }, now);
    });
    transaction();
    return publicRelease(this.#require(key));
  }

  submit({ actorAccountId, ...rawKey }) {
    const key = releaseKey(rawKey);
    const row = this.#require(key);
    this.#requirePublisher(row, actorAccountId);
    if (row.state !== 'draft') {
      throw new ExtensionReleaseStoreError('INVALID_RELEASE_STATE', 'only draft releases can be submitted');
    }
    const now = this.now();
    const transaction = this.db.transaction(() => {
      this.s.submit.run({ ...key, submittedAtMs: now, updatedAtMs: now });
      this.#audit(key, 'release.submitted', actorAccountId, { descriptorDigest: row.descriptorDigest }, now);
    });
    transaction();
    return publicRelease(this.#require(key));
  }

  review({ approved, reviewer, notes = '', ...rawKey }) {
    const key = releaseKey(rawKey);
    const row = this.#require(key);
    if (row.state !== 'pending_review') {
      throw new ExtensionReleaseStoreError('INVALID_RELEASE_STATE', 'release is not pending review');
    }
    const state = approved === true ? 'approved' : 'rejected';
    let approvedArtifacts = null;
    if (approved === true && this.artifactStore) {
      approvedArtifacts = this.artifactStore.approvalGate(key);
    }
    const reviewerName = String(reviewer ?? 'marketplace-reviewer').trim().slice(0, 160) || 'marketplace-reviewer';
    const reviewNotes = String(notes ?? '').trim().slice(0, 4000);
    const now = this.now();
    let signature = null;
    const transaction = this.db.transaction(() => {
      if (approved === true && this.signingStore) {
        const descriptor = parseJson(row.descriptorJson, null);
        signature = this.signingStore.signRelease({
          descriptor,
          descriptorDigest: row.descriptorDigest,
          artifacts: approvedArtifacts ?? [],
        });
      }
      this.s.review.run({
        ...key,
        state,
        reviewedAtMs: now,
        reviewer: reviewerName,
        reviewNotes,
        updatedAtMs: now,
      });
      this.#audit(key, `release.${state}`, reviewerName, {
        notes: reviewNotes,
        ...(approvedArtifacts ? {
          artifacts: approvedArtifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            digest: artifact.digest,
          })),
        } : {}),
        ...(signature ? {
          signature: {
            keyId: signature.keyId,
            trustEpoch: signature.trustEpoch,
            publicKeyFingerprint: signature.publicKeyFingerprint,
          },
        } : {}),
      }, now);
    });
    transaction();
    return publicRelease(this.#require(key));
  }

  yank({ actorAccountId, notes = '', ...rawKey }) {
    const key = releaseKey(rawKey);
    const row = this.#require(key);
    this.#requirePublisher(row, actorAccountId);
    if (row.state !== 'approved') {
      throw new ExtensionReleaseStoreError('INVALID_RELEASE_STATE', 'only approved releases can be yanked');
    }
    return this.#revoke(key, row, String(actorAccountId), notes, 'release.yanked');
  }

  revoke({ reviewer, notes = '', ...rawKey }) {
    const key = releaseKey(rawKey);
    const row = this.#require(key);
    if (row.state !== 'approved') {
      throw new ExtensionReleaseStoreError('INVALID_RELEASE_STATE', 'only approved releases can be revoked');
    }
    const actor = String(reviewer ?? 'marketplace-reviewer').trim().slice(0, 160) || 'marketplace-reviewer';
    return this.#revoke(key, row, actor, notes, 'release.revoked');
  }

  #revoke(key, row, actor, notes, action) {
    const reviewNotes = String(notes ?? '').trim().slice(0, 4000);
    const now = this.now();
    const transaction = this.db.transaction(() => {
      this.s.revoke.run({
        ...key,
        revokedAtMs: now,
        reviewer: actor,
        reviewNotes,
        updatedAtMs: now,
      });
      this.#audit(key, action, actor, { previousState: row.state, notes: reviewNotes }, now);
    });
    transaction();
    return publicRelease(this.#require(key));
  }

  listPublisher(actorAccountId) {
    const namespaces = this.publisherStore.listOwned(actorAccountId).map((item) => item.namespace);
    return namespaces
      .flatMap((namespace) => this.s.listNamespace.all(namespace))
      .sort((left, right) => Number(right.updatedAtMs) - Number(left.updatedAtMs)
        || left.namespace.localeCompare(right.namespace)
        || left.name.localeCompare(right.name)
        || left.version.localeCompare(right.version))
      .map((row) => publicRelease(row));
  }

  listApprovedLatest() {
    const byIdentity = new Map();
    for (const row of this.s.listApproved.all()) {
      if (!RELEASE_STATES.has(row.state)) continue;
      const descriptor = parseJson(row.descriptorJson, null);
      if (!descriptor) continue;
      const id = descriptor.id;
      const previous = byIdentity.get(id);
      if (!previous || compareVersions(row.version, previous.version) > 0) {
        byIdentity.set(id, { version: row.version, descriptor, digest: row.descriptorDigest });
      }
    }
    return [...byIdentity.values()]
      .map(({ descriptor, digest, ...value }) => {
        const releaseKeyValue = {
          kind: descriptor.identity.kind,
          namespace: descriptor.identity.namespace,
          name: descriptor.identity.name,
          version: value.version,
        };
        const artifacts = this.artifactStore
          ? this.artifactStore.listForRelease(releaseKeyValue)
          : [];
        const signature = this.signingStore
          ? this.signingStore.getSignature(releaseKeyValue)
          : null;
        return {
          ...descriptor,
          release: {
            ...descriptor.release,
            descriptorDigest: digest,
            ...(artifacts.length ? { artifacts } : {}),
            ...(signature ? { signature } : {}),
          },
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  audit(rawKey) {
    const key = releaseKey(rawKey);
    return this.s.auditList.all(key.kind, key.namespace, key.name, key.version).map((row) => ({
      sequence: Number(row.sequence),
      action: row.action,
      actor: row.actor,
      payload: parseJson(row.payloadJson, {}),
      occurredAtMs: Number(row.occurredAtMs),
    }));
  }
}

export function extensionReleaseErrorFromRegistry(error) {
  if (!(error instanceof ExtensionRegistryError)) return error;
  return new ExtensionReleaseStoreError(error.code, error.message);
}
