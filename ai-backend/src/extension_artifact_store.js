import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SAFE_COMPONENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const SCAN_STATES = new Set(['pending', 'passed', 'rejected']);

function safeComponent(value, field) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase();
  if (!SAFE_COMPONENT.test(normalized)) {
    throw new ExtensionArtifactStoreError('INVALID_ARTIFACT_IDENTITY', `${field} is invalid`);
  }
  return normalized;
}

function safeVersion(value) {
  const normalized = String(value ?? '').trim();
  if (!VERSION_PATTERN.test(normalized)) {
    throw new ExtensionArtifactStoreError('INVALID_ARTIFACT_VERSION', 'version must use semantic versioning');
  }
  return normalized;
}

function releaseKey(input = {}) {
  return {
    kind: safeComponent(input.kind, 'kind'),
    namespace: safeComponent(input.namespace, 'namespace'),
    name: safeComponent(input.name, 'name'),
    version: safeVersion(input.version),
  };
}

function artifactId(value) {
  return safeComponent(value, 'artifactId');
}

function optionalComponent(value, fallback, field) {
  const normalized = String(value ?? fallback ?? '').trim().toLocaleLowerCase();
  if (!normalized) return fallback;
  if (!SAFE_COMPONENT.test(normalized)) {
    throw new ExtensionArtifactStoreError('INVALID_ARTIFACT_METADATA', `${field} is invalid`);
  }
  return normalized;
}

function publicArtifact(row) {
  if (!row) return null;
  return {
    artifactId: row.artifactId,
    digest: row.digest,
    sizeBytes: Number(row.sizeBytes),
    platform: row.platform,
    architecture: row.architecture,
    format: row.format,
    scan: {
      state: row.scanState,
      scanner: row.scanner || '',
      scannerVersion: row.scannerVersion || '',
      notes: row.scanNotes || '',
      scannedAtMs: row.scannedAtMs == null ? null : Number(row.scannedAtMs),
    },
    createdAtMs: Number(row.createdAtMs),
  };
}

export class ExtensionArtifactStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtensionArtifactStoreError';
    this.code = code;
  }
}

export class ExtensionArtifactStore {
  constructor({
    db,
    dataDir,
    publisherStore,
    releaseStore,
    now = () => Date.now(),
    maxArtifactBytes = MAX_ARTIFACT_BYTES,
  } = {}) {
    if (!db) throw new Error('ExtensionArtifactStore requires the existing Marketplace SQLite connection');
    if (!publisherStore) throw new Error('ExtensionArtifactStore requires ExtensionPublisherStore');
    if (!releaseStore) throw new Error('ExtensionArtifactStore requires ExtensionReleaseStore');
    this.db = db;
    this.publisherStore = publisherStore;
    this.releaseStore = releaseStore;
    this.now = now;
    this.maxArtifactBytes = Math.max(1, Number(maxArtifactBytes) || MAX_ARTIFACT_BYTES);
    this.casRoot = path.resolve(dataDir ?? process.cwd(), 'extensions', 'artifacts', 'sha256');
    fs.mkdirSync(this.casRoot, { recursive: true, mode: 0o700 });
    this.#ensureSchema();
    this.#prepare();
  }

  #ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_release_artifacts (
        kind TEXT NOT NULL,
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        platform TEXT NOT NULL,
        architecture TEXT NOT NULL,
        format TEXT NOT NULL,
        scan_state TEXT NOT NULL DEFAULT 'pending',
        scanner TEXT,
        scanner_version TEXT,
        scan_notes TEXT NOT NULL DEFAULT '',
        scanned_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (kind, namespace, name, version, artifact_id)
      );

      CREATE INDEX IF NOT EXISTS idx_extension_release_artifacts_digest
        ON extension_release_artifacts (digest);

      CREATE INDEX IF NOT EXISTS idx_extension_release_artifacts_release
        ON extension_release_artifacts (kind, namespace, name, version);

      CREATE TABLE IF NOT EXISTS extension_artifact_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        digest TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        occurred_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_extension_artifact_audit_digest_sequence
        ON extension_artifact_audit (digest, sequence ASC);
    `);
  }

  #prepare() {
    const select = `
      SELECT kind, namespace, name, version,
        artifact_id AS artifactId, digest, size_bytes AS sizeBytes,
        platform, architecture, format, scan_state AS scanState,
        scanner, scanner_version AS scannerVersion,
        scan_notes AS scanNotes, scanned_at_ms AS scannedAtMs,
        created_at_ms AS createdAtMs
      FROM extension_release_artifacts
    `;
    this.s = {
      getBinding: this.db.prepare(`${select}
        WHERE kind = ? AND namespace = ? AND name = ? AND version = ? AND artifact_id = ?
        LIMIT 1
      `),
      insertBinding: this.db.prepare(`
        INSERT INTO extension_release_artifacts (
          kind, namespace, name, version, artifact_id, digest, size_bytes,
          platform, architecture, format, scan_state, created_at_ms
        ) VALUES (
          @kind, @namespace, @name, @version, @artifactId, @digest, @sizeBytes,
          @platform, @architecture, @format, 'pending', @createdAtMs
        )
      `),
      listRelease: this.db.prepare(`${select}
        WHERE kind = ? AND namespace = ? AND name = ? AND version = ?
        ORDER BY artifact_id ASC
      `),
      scan: this.db.prepare(`
        UPDATE extension_release_artifacts
        SET scan_state = @scanState, scanner = @scanner,
          scanner_version = @scannerVersion, scan_notes = @scanNotes,
          scanned_at_ms = @scannedAtMs
        WHERE kind = @kind AND namespace = @namespace AND name = @name
          AND version = @version AND artifact_id = @artifactId
      `),
      approvedDigest: this.db.prepare(`
        SELECT a.digest, a.size_bytes AS sizeBytes
        FROM extension_release_artifacts a
        INNER JOIN extension_releases r
          ON r.kind = a.kind
          AND r.namespace = a.namespace
          AND r.name = a.name
          AND r.version = a.version
        WHERE a.digest = ? AND a.scan_state = 'passed' AND r.state = 'approved'
        LIMIT 1
      `),
      auditInsert: this.db.prepare(`
        INSERT INTO extension_artifact_audit (
          digest, action, actor, payload_json, occurred_at_ms
        ) VALUES (@digest, @action, @actor, @payloadJson, @occurredAtMs)
      `),
    };
  }

  #casPath(digest) {
    if (!DIGEST_PATTERN.test(String(digest ?? ''))) {
      throw new ExtensionArtifactStoreError('INVALID_ARTIFACT_DIGEST', 'artifact digest is invalid');
    }
    return path.join(this.casRoot, digest.slice(0, 2), digest);
  }

  #writeCas(digest, bytes) {
    const destination = this.#casPath(digest);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (fs.existsSync(destination)) {
      const stat = fs.statSync(destination);
      if (!stat.isFile() || stat.size !== bytes.length) {
        throw new ExtensionArtifactStoreError('ARTIFACT_CAS_CORRUPT', 'existing CAS object does not match artifact size');
      }
      return destination;
    }
    const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, destination);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
    return destination;
  }

  #audit(digest, action, actor, payload = {}) {
    this.s.auditInsert.run({
      digest,
      action,
      actor: String(actor ?? ''),
      payloadJson: JSON.stringify(payload),
      occurredAtMs: this.now(),
    });
  }

  upload({
    actorAccountId,
    kind,
    namespace,
    name,
    version,
    artifactId: rawArtifactId,
    platform,
    architecture = 'any',
    format,
    bytes,
  }) {
    const key = releaseKey({ kind, namespace, name, version });
    this.publisherStore.assertOwned(key.namespace, actorAccountId);
    const release = this.releaseStore.getRelease(key);
    if (!release) {
      throw new ExtensionArtifactStoreError('RELEASE_NOT_FOUND', 'release must exist before artifact upload');
    }
    if (!['draft', 'pending_review'].includes(release.state)) {
      throw new ExtensionArtifactStoreError('ARTIFACT_RELEASE_FROZEN', 'artifacts cannot be added after review');
    }
    const id = artifactId(rawArtifactId);
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    if (body.length <= 0 || body.length > this.maxArtifactBytes) {
      throw new ExtensionArtifactStoreError('INVALID_ARTIFACT_SIZE', 'artifact size is outside allowed bounds');
    }
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    const existing = this.s.getBinding.get(key.kind, key.namespace, key.name, key.version, id);
    if (existing) {
      if (existing.digest !== digest) {
        throw new ExtensionArtifactStoreError('ARTIFACT_BINDING_CONFLICT', 'artifact id is immutable for this release');
      }
      return publicArtifact(existing);
    }

    this.#writeCas(digest, body);
    const now = this.now();
    this.s.insertBinding.run({
      ...key,
      artifactId: id,
      digest,
      sizeBytes: body.length,
      platform: optionalComponent(platform, 'all', 'platform'),
      architecture: optionalComponent(architecture, 'any', 'architecture'),
      format: optionalComponent(format, 'binary', 'format'),
      createdAtMs: now,
    });
    this.#audit(digest, 'artifact.uploaded', actorAccountId, {
      ...key,
      artifactId: id,
      sizeBytes: body.length,
    });
    return publicArtifact(this.s.getBinding.get(key.kind, key.namespace, key.name, key.version, id));
  }

  recordScan({
    reviewer,
    kind,
    namespace,
    name,
    version,
    artifactId: rawArtifactId,
    state,
    scanner,
    scannerVersion,
    notes = '',
  }) {
    const key = releaseKey({ kind, namespace, name, version });
    const id = artifactId(rawArtifactId);
    const nextState = String(state ?? '').trim().toLocaleLowerCase();
    if (!SCAN_STATES.has(nextState) || nextState === 'pending') {
      throw new ExtensionArtifactStoreError('INVALID_SCAN_STATE', 'scan result must be passed or rejected');
    }
    const existing = this.s.getBinding.get(key.kind, key.namespace, key.name, key.version, id);
    if (!existing) throw new ExtensionArtifactStoreError('ARTIFACT_NOT_FOUND', 'artifact was not found');
    if (existing.scanState !== 'pending') {
      throw new ExtensionArtifactStoreError('SCAN_ALREADY_FINAL', 'artifact scan verdict is immutable');
    }
    const scannerName = String(scanner ?? '').trim().slice(0, 160);
    const scannerVersionValue = String(scannerVersion ?? '').trim().slice(0, 160);
    if (!scannerName || !scannerVersionValue) {
      throw new ExtensionArtifactStoreError('INVALID_SCANNER', 'scanner and scannerVersion are required');
    }
    const scannedAtMs = this.now();
    this.s.scan.run({
      ...key,
      artifactId: id,
      scanState: nextState,
      scanner: scannerName,
      scannerVersion: scannerVersionValue,
      scanNotes: String(notes ?? '').trim().slice(0, 4000),
      scannedAtMs,
    });
    this.#audit(existing.digest, `artifact.scan.${nextState}`, reviewer, {
      ...key,
      artifactId: id,
      scanner: scannerName,
      scannerVersion: scannerVersionValue,
    });
    return publicArtifact(this.s.getBinding.get(key.kind, key.namespace, key.name, key.version, id));
  }

  listForRelease(input) {
    const key = releaseKey(input);
    return this.s.listRelease
      .all(key.kind, key.namespace, key.name, key.version)
      .map(publicArtifact);
  }

  approvalGate(input) {
    const artifacts = this.listForRelease(input);
    if (artifacts.length === 0) {
      throw new ExtensionArtifactStoreError('ARTIFACT_REQUIRED', 'release has no artifact');
    }
    const blocked = artifacts.find((artifact) => artifact.scan.state !== 'passed');
    if (blocked) {
      throw new ExtensionArtifactStoreError(
        'ARTIFACT_SCAN_REQUIRED',
        `artifact ${blocked.artifactId} has not passed security scan`,
      );
    }
    return artifacts;
  }

  approvedArtifact(digest) {
    const normalized = String(digest ?? '').trim().toLocaleLowerCase();
    if (!DIGEST_PATTERN.test(normalized)) {
      throw new ExtensionArtifactStoreError('INVALID_ARTIFACT_DIGEST', 'artifact digest is invalid');
    }
    const row = this.s.approvedDigest.get(normalized);
    if (!row) return null;
    return {
      digest: normalized,
      sizeBytes: Number(row.sizeBytes),
      path: this.#casPath(normalized),
    };
  }
}
