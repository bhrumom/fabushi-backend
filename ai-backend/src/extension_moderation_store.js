import crypto from 'node:crypto';

const CASE_TYPES = new Set(['report', 'appeal']);
const REPORT_STATES = new Set(['open', 'dismissed', 'actioned']);
const APPEAL_STATES = new Set(['open', 'accepted', 'rejected']);
const REPORT_REASONS = new Set(['malware', 'impersonation', 'privacy', 'policy', 'other']);
const SAFE_COMPONENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

function bounded(value, field, max, { required = true } = {}) {
  const text = String(value ?? '').trim();
  if ((required && !text) || text.length > max) {
    throw new ExtensionModerationStoreError('INVALID_MODERATION_INPUT', `${field} is invalid`);
  }
  return text;
}

function component(value, field) {
  const text = bounded(value, field, 128).toLocaleLowerCase();
  if (!SAFE_COMPONENT.test(text)) {
    throw new ExtensionModerationStoreError('INVALID_MODERATION_RELEASE', `${field} is invalid`);
  }
  return text;
}

function version(value) {
  const text = bounded(value, 'version', 128);
  if (!VERSION_PATTERN.test(text)) {
    throw new ExtensionModerationStoreError('INVALID_MODERATION_RELEASE', 'version is invalid');
  }
  return text;
}

function releaseKey(value = {}) {
  return {
    kind: component(value.kind, 'kind'),
    namespace: component(value.namespace, 'namespace'),
    name: component(value.name, 'name'),
    version: version(value.version),
  };
}

function caseId(value) {
  const text = bounded(value, 'caseId', 80);
  if (!/^[0-9a-f-]{36}$/i.test(text)) {
    throw new ExtensionModerationStoreError('INVALID_CASE_ID', 'caseId is invalid');
  }
  return text;
}

function accountId(value) {
  return bounded(value, 'accountId', 240);
}

function reasonCode(value) {
  const text = bounded(value, 'reasonCode', 40).toLocaleLowerCase();
  if (!REPORT_REASONS.has(text)) {
    throw new ExtensionModerationStoreError('INVALID_REPORT_REASON', 'report reason is invalid');
  }
  return text;
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(String(value ?? ''));
  } catch {
    return fallback;
  }
}

function publicCase(row) {
  if (!row) return null;
  return {
    caseId: row.caseId,
    type: row.caseType,
    state: row.state,
    release: {
      kind: row.kind,
      namespace: row.namespace,
      name: row.name,
      version: row.version,
    },
    reasonCode: row.reasonCode || '',
    details: row.details || '',
    parentCaseId: row.parentCaseId || null,
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
    resolvedAtMs: row.resolvedAtMs == null ? null : Number(row.resolvedAtMs),
    resolution: row.resolution || '',
  };
}

export class ExtensionModerationStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtensionModerationStoreError';
    this.code = code;
  }
}

export class ExtensionModerationStore {
  constructor({ db, publisherStore, releaseStore, now = () => Date.now() } = {}) {
    if (!db) throw new Error('ExtensionModerationStore requires existing Marketplace SQLite connection');
    if (!publisherStore) throw new Error('ExtensionModerationStore requires ExtensionPublisherStore');
    if (!releaseStore) throw new Error('ExtensionModerationStore requires ExtensionReleaseStore');
    this.db = db;
    this.publisherStore = publisherStore;
    this.releaseStore = releaseStore;
    this.now = now;
    this.#ensureSchema();
    this.#prepare();
  }

  #ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_moderation_cases (
        case_id TEXT PRIMARY KEY,
        case_type TEXT NOT NULL,
        state TEXT NOT NULL,
        kind TEXT NOT NULL,
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        reporter_account_id TEXT,
        appellant_account_id TEXT,
        reason_code TEXT,
        details TEXT NOT NULL DEFAULT '',
        parent_case_id TEXT,
        reviewer TEXT,
        resolution TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_extension_moderation_release
        ON extension_moderation_cases (kind, namespace, name, version, created_at_ms DESC);

      CREATE INDEX IF NOT EXISTS idx_extension_moderation_reporter
        ON extension_moderation_cases (reporter_account_id, created_at_ms DESC);

      CREATE INDEX IF NOT EXISTS idx_extension_moderation_parent
        ON extension_moderation_cases (parent_case_id, created_at_ms DESC);

      CREATE TABLE IF NOT EXISTS extension_moderation_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        occurred_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_extension_moderation_audit_case
        ON extension_moderation_audit (case_id, sequence ASC);
    `);
  }

  #prepare() {
    const select = `
      SELECT case_id AS caseId, case_type AS caseType, state,
        kind, namespace, name, version,
        reporter_account_id AS reporterAccountId,
        appellant_account_id AS appellantAccountId,
        reason_code AS reasonCode, details,
        parent_case_id AS parentCaseId, reviewer, resolution,
        created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs,
        resolved_at_ms AS resolvedAtMs
      FROM extension_moderation_cases
    `;
    this.s = {
      get: this.db.prepare(`${select} WHERE case_id = ? LIMIT 1`),
      duplicateReport: this.db.prepare(`${select}
        WHERE case_type = 'report' AND state = 'open'
          AND reporter_account_id = @reporterAccountId
          AND kind = @kind AND namespace = @namespace AND name = @name AND version = @version
        LIMIT 1
      `),
      duplicateAppeal: this.db.prepare(`${select}
        WHERE case_type = 'appeal' AND state = 'open' AND parent_case_id = ?
        LIMIT 1
      `),
      insert: this.db.prepare(`
        INSERT INTO extension_moderation_cases (
          case_id, case_type, state, kind, namespace, name, version,
          reporter_account_id, appellant_account_id,
          reason_code, details, parent_case_id,
          created_at_ms, updated_at_ms
        ) VALUES (
          @caseId, @caseType, 'open', @kind, @namespace, @name, @version,
          @reporterAccountId, @appellantAccountId,
          @reasonCode, @details, @parentCaseId,
          @createdAtMs, @updatedAtMs
        )
      `),
      resolve: this.db.prepare(`
        UPDATE extension_moderation_cases
        SET state = @state, reviewer = @reviewer, resolution = @resolution,
          resolved_at_ms = @resolvedAtMs, updated_at_ms = @updatedAtMs
        WHERE case_id = @caseId AND state = 'open'
      `),
      listMine: this.db.prepare(`${select}
        WHERE case_type = 'report' AND reporter_account_id = ?
        ORDER BY created_at_ms DESC, case_id ASC
      `),
      listAppeals: this.db.prepare(`${select}
        WHERE case_type = 'appeal'
        ORDER BY created_at_ms DESC, case_id ASC
      `),
      auditInsert: this.db.prepare(`
        INSERT INTO extension_moderation_audit (
          case_id, action, actor, payload_json, occurred_at_ms
        ) VALUES (@caseId, @action, @actor, @payloadJson, @occurredAtMs)
      `),
      auditList: this.db.prepare(`
        SELECT sequence, action, actor, payload_json AS payloadJson,
          occurred_at_ms AS occurredAtMs
        FROM extension_moderation_audit
        WHERE case_id = ?
        ORDER BY sequence ASC
      `),
    };
  }

  #require(rawCaseId) {
    const id = caseId(rawCaseId);
    const row = this.s.get.get(id);
    if (!row) throw new ExtensionModerationStoreError('CASE_NOT_FOUND', 'moderation case was not found');
    return row;
  }

  #audit(id, action, actor, payload, occurredAtMs) {
    this.s.auditInsert.run({
      caseId: id,
      action,
      actor: bounded(actor, 'actor', 240),
      payloadJson: JSON.stringify(payload ?? {}),
      occurredAtMs,
    });
  }

  createReport({ reporterAccountId, reasonCode: rawReasonCode, details = '', ...rawRelease }) {
    const reporter = accountId(reporterAccountId);
    const key = releaseKey(rawRelease);
    if (!this.releaseStore.getRelease(key)) {
      throw new ExtensionModerationStoreError('MODERATION_RELEASE_NOT_FOUND', 'release was not found');
    }
    const reason = reasonCode(rawReasonCode);
    const reportDetails = bounded(details, 'details', 4000, { required: false });
    if (this.s.duplicateReport.get({ reporterAccountId: reporter, ...key })) {
      throw new ExtensionModerationStoreError('DUPLICATE_OPEN_REPORT', 'an open report already exists for this release');
    }
    const id = crypto.randomUUID();
    const now = this.now();
    const transaction = this.db.transaction(() => {
      this.s.insert.run({
        caseId: id,
        caseType: 'report',
        ...key,
        reporterAccountId: reporter,
        appellantAccountId: null,
        reasonCode: reason,
        details: reportDetails,
        parentCaseId: null,
        createdAtMs: now,
        updatedAtMs: now,
      });
      this.#audit(id, 'report.created', `account:${reporter}`, { reasonCode: reason }, now);
    });
    transaction();
    return publicCase(this.#require(id));
  }

  listMine(reporterAccountId) {
    return this.s.listMine.all(accountId(reporterAccountId)).map(publicCase);
  }

  resolveReport({ caseId: rawCaseId, decision, reviewer, resolution = '' }) {
    const row = this.#require(rawCaseId);
    if (row.caseType !== 'report') {
      throw new ExtensionModerationStoreError('WRONG_CASE_TYPE', 'case is not a report');
    }
    if (!REPORT_STATES.has(row.state) || row.state !== 'open') {
      throw new ExtensionModerationStoreError('CASE_ALREADY_RESOLVED', 'report is already resolved');
    }
    const normalizedDecision = bounded(decision, 'decision', 24).toLocaleLowerCase();
    if (!['dismiss', 'revoke'].includes(normalizedDecision)) {
      throw new ExtensionModerationStoreError('INVALID_MODERATION_DECISION', 'report decision is invalid');
    }
    const reviewerName = bounded(reviewer ?? 'marketplace-reviewer', 'reviewer', 160);
    const resolutionText = bounded(resolution, 'resolution', 4000, { required: false });
    const key = releaseKey(row);

    if (normalizedDecision === 'revoke') {
      const release = this.releaseStore.getRelease(key);
      if (!release) {
        throw new ExtensionModerationStoreError('MODERATION_RELEASE_NOT_FOUND', 'release was not found');
      }
      if (release.state === 'approved') {
        this.releaseStore.revoke({
          ...key,
          reviewer: reviewerName,
          notes: resolutionText || `moderation case ${row.caseId}`,
        });
      } else if (release.state !== 'revoked') {
        throw new ExtensionModerationStoreError(
          'RELEASE_NOT_ACTIONABLE',
          'only approved or already revoked releases can be actioned',
        );
      }
    }

    const now = this.now();
    const state = normalizedDecision === 'revoke' ? 'actioned' : 'dismissed';
    const transaction = this.db.transaction(() => {
      const result = this.s.resolve.run({
        caseId: row.caseId,
        state,
        reviewer: reviewerName,
        resolution: resolutionText,
        resolvedAtMs: now,
        updatedAtMs: now,
      });
      if (result.changes !== 1) {
        throw new ExtensionModerationStoreError('CASE_ALREADY_RESOLVED', 'report is already resolved');
      }
      this.#audit(
        row.caseId,
        `report.${state}`,
        `reviewer:${reviewerName}`,
        { decision: normalizedDecision },
        now,
      );
    });
    transaction();
    return publicCase(this.#require(row.caseId));
  }

  createAppeal({ reportCaseId, actorAccountId, details = '' }) {
    const report = this.#require(reportCaseId);
    if (report.caseType !== 'report' || report.state !== 'actioned') {
      throw new ExtensionModerationStoreError('REPORT_NOT_APPEALABLE', 'report is not eligible for appeal');
    }
    const actor = accountId(actorAccountId);
    this.publisherStore.assertOwned(report.namespace, actor);
    if (this.s.duplicateAppeal.get(report.caseId)) {
      throw new ExtensionModerationStoreError('DUPLICATE_OPEN_APPEAL', 'an open appeal already exists for this report');
    }
    const appealDetails = bounded(details, 'details', 4000);
    const id = crypto.randomUUID();
    const now = this.now();
    const transaction = this.db.transaction(() => {
      this.s.insert.run({
        caseId: id,
        caseType: 'appeal',
        kind: report.kind,
        namespace: report.namespace,
        name: report.name,
        version: report.version,
        reporterAccountId: null,
        appellantAccountId: actor,
        reasonCode: null,
        details: appealDetails,
        parentCaseId: report.caseId,
        createdAtMs: now,
        updatedAtMs: now,
      });
      this.#audit(id, 'appeal.created', `account:${actor}`, { reportCaseId: report.caseId }, now);
    });
    transaction();
    return publicCase(this.#require(id));
  }

  listPublisherAppeals(actorAccountId) {
    const actor = accountId(actorAccountId);
    const owned = new Set(this.publisherStore.listOwned(actor).map((item) => item.namespace));
    return this.s.listAppeals.all()
      .filter((row) => owned.has(row.namespace) && row.appellantAccountId === actor)
      .map(publicCase);
  }

  resolveAppeal({ caseId: rawCaseId, decision, reviewer, resolution = '' }) {
    const row = this.#require(rawCaseId);
    if (row.caseType !== 'appeal') {
      throw new ExtensionModerationStoreError('WRONG_CASE_TYPE', 'case is not an appeal');
    }
    if (!APPEAL_STATES.has(row.state) || row.state !== 'open') {
      throw new ExtensionModerationStoreError('CASE_ALREADY_RESOLVED', 'appeal is already resolved');
    }
    const normalizedDecision = bounded(decision, 'decision', 24).toLocaleLowerCase();
    if (!['accept', 'reject'].includes(normalizedDecision)) {
      throw new ExtensionModerationStoreError('INVALID_MODERATION_DECISION', 'appeal decision is invalid');
    }
    const reviewerName = bounded(reviewer ?? 'marketplace-reviewer', 'reviewer', 160);
    const resolutionText = bounded(resolution, 'resolution', 4000, { required: false });
    const state = normalizedDecision === 'accept' ? 'accepted' : 'rejected';
    const now = this.now();
    const transaction = this.db.transaction(() => {
      const result = this.s.resolve.run({
        caseId: row.caseId,
        state,
        reviewer: reviewerName,
        resolution: resolutionText,
        resolvedAtMs: now,
        updatedAtMs: now,
      });
      if (result.changes !== 1) {
        throw new ExtensionModerationStoreError('CASE_ALREADY_RESOLVED', 'appeal is already resolved');
      }
      this.#audit(
        row.caseId,
        `appeal.${state}`,
        `reviewer:${reviewerName}`,
        { decision: normalizedDecision },
        now,
      );
    });
    transaction();
    return publicCase(this.#require(row.caseId));
  }

  audit(rawCaseId) {
    const row = this.#require(rawCaseId);
    if (!CASE_TYPES.has(row.caseType)) {
      throw new ExtensionModerationStoreError('WRONG_CASE_TYPE', 'unknown moderation case type');
    }
    return this.s.auditList.all(row.caseId).map((entry) => ({
      sequence: Number(entry.sequence),
      action: entry.action,
      actor: entry.actor,
      payload: parseJson(entry.payloadJson, {}),
      occurredAtMs: Number(entry.occurredAtMs),
    }));
  }

  get(rawCaseId) {
    return publicCase(this.#require(rawCaseId));
  }
}
