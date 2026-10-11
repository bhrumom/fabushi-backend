import crypto from 'node:crypto';
import process from 'node:process';

const SIGNATURE_PROTOCOL = 'fabushi.extension-release-signature.v1';
const TRUST_FEED_PROTOCOL = 'fabushi.extension-trust-feed.v1';
const DEFAULT_TRUST_FEED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRUST_FEED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TRUST_FEED_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function positiveEpoch(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ExtensionSigningStoreError('INVALID_TRUST_EPOCH', 'trust epoch must be a positive integer');
  }
  return parsed;
}

function trustFeedTtlMs(value) {
  const parsed = Number(value ?? DEFAULT_TRUST_FEED_TTL_MS);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TRUST_FEED_TTL_MS) {
    throw new ExtensionSigningStoreError(
      'INVALID_TRUST_FEED_TTL',
      'trust feed TTL must be a positive integer no greater than 7 days',
    );
  }
  return parsed;
}

function keyId(value) {
  const normalized = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new ExtensionSigningStoreError('INVALID_SIGNING_KEY_ID', 'signing key id is invalid');
  }
  return normalized;
}

function releaseKey(input = {}) {
  const kind = String(input.kind ?? '').trim().toLocaleLowerCase();
  const namespace = String(input.namespace ?? '').trim().toLocaleLowerCase();
  const name = String(input.name ?? '').trim().toLocaleLowerCase();
  const version = String(input.version ?? '').trim();
  if (!kind || !namespace || !name || !version) {
    throw new ExtensionSigningStoreError('INVALID_SIGNING_RELEASE', 'release identity is incomplete');
  }
  return { kind, namespace, name, version };
}

function publicEnvelope(row) {
  if (!row) return null;
  return {
    protocol: SIGNATURE_PROTOCOL,
    algorithm: row.algorithm,
    keyId: row.keyId,
    trustEpoch: Number(row.trustEpoch),
    publicKey: row.publicKey,
    publicKeyFingerprint: row.publicKeyFingerprint,
    payload: row.payload,
    signature: row.signature,
    signedAtMs: Number(row.signedAtMs),
  };
}

export class ExtensionSigningStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtensionSigningStoreError';
    this.code = code;
  }
}

export function loadConfiguredMarketplaceSigner(env = process.env) {
  const rawPrivateKey = String(env.FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY ?? '').trim();
  const rawKeyId = String(env.FABUSHI_MARKETPLACE_SIGNING_KEY_ID ?? '').trim();
  const rawEpoch = String(env.FABUSHI_MARKETPLACE_TRUST_EPOCH ?? '').trim();
  if (!rawPrivateKey && !rawKeyId && !rawEpoch) return null;
  if (!rawPrivateKey || !rawKeyId || !rawEpoch) {
    throw new ExtensionSigningStoreError(
      'INCOMPLETE_SIGNING_CONFIGURATION',
      'marketplace signing private key, key id and trust epoch must be configured together',
    );
  }

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(rawPrivateKey.replace(/\\n/g, '\n'));
  } catch {
    throw new ExtensionSigningStoreError('INVALID_SIGNING_PRIVATE_KEY', 'marketplace signing private key is invalid');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new ExtensionSigningStoreError('INVALID_SIGNING_PRIVATE_KEY', 'marketplace signing key must be Ed25519');
  }
  const publicKeyObject = crypto.createPublicKey(privateKey);
  const publicDer = publicKeyObject.export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    publicKeyObject,
    publicKey: publicDer.toString('base64'),
    publicKeyFingerprint: crypto.createHash('sha256').update(publicDer).digest('hex'),
    keyId: keyId(rawKeyId),
    trustEpoch: positiveEpoch(rawEpoch),
  };
}

export function canonicalReleaseSignaturePayload({
  signer,
  descriptor,
  descriptorDigest,
  artifacts,
}) {
  if (!signer) {
    throw new ExtensionSigningStoreError('SIGNING_KEY_REQUIRED', 'managed Marketplace signing key is not configured');
  }
  if (!/^[0-9a-f]{64}$/.test(String(descriptorDigest ?? ''))) {
    throw new ExtensionSigningStoreError('INVALID_DESCRIPTOR_DIGEST', 'descriptor digest is invalid');
  }
  const normalizedArtifacts = [...(artifacts ?? [])]
    .map((artifact) => ({
      artifactId: String(artifact.artifactId),
      digest: String(artifact.digest),
      sizeBytes: Number(artifact.sizeBytes),
      platform: String(artifact.platform),
      architecture: String(artifact.architecture),
      format: String(artifact.format),
    }))
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  if (normalizedArtifacts.length === 0 || normalizedArtifacts.some(
    (artifact) => !/^[0-9a-f]{64}$/.test(artifact.digest)
      || !Number.isSafeInteger(artifact.sizeBytes)
      || artifact.sizeBytes <= 0,
  )) {
    throw new ExtensionSigningStoreError('INVALID_SIGNING_ARTIFACTS', 'signed release requires valid scanned artifacts');
  }
  const identity = descriptor?.identity;
  if (!identity?.kind || !identity?.namespace || !identity?.name || !descriptor?.release?.version) {
    throw new ExtensionSigningStoreError('INVALID_SIGNING_RELEASE', 'descriptor identity/version is incomplete');
  }
  return JSON.stringify({
    protocol: SIGNATURE_PROTOCOL,
    keyId: signer.keyId,
    trustEpoch: signer.trustEpoch,
    identity: {
      namespace: String(identity.namespace),
      name: String(identity.name),
      kind: String(identity.kind),
    },
    version: String(descriptor.release.version),
    descriptorDigest: String(descriptorDigest),
    artifacts: normalizedArtifacts,
  });
}

export function canonicalTrustFeedPayload({
  signer,
  keys,
  issuedAtMs,
  expiresAtMs,
}) {
  if (!signer) {
    throw new ExtensionSigningStoreError('SIGNING_KEY_REQUIRED', 'managed Marketplace signing key is not configured');
  }
  if (!Number.isSafeInteger(issuedAtMs) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= issuedAtMs) {
    throw new ExtensionSigningStoreError('INVALID_TRUST_FEED_WINDOW', 'trust feed validity window is invalid');
  }
  const normalizedKeys = [...(keys ?? [])]
    .map((item) => ({
      algorithm: String(item.algorithm),
      keyId: keyId(item.keyId),
      trustEpoch: positiveEpoch(item.trustEpoch),
      publicKey: String(item.publicKey),
      publicKeyFingerprint: String(item.publicKeyFingerprint),
      status: item.status === 'revoked' ? 'revoked' : 'active',
      createdAtMs: Number(item.createdAtMs),
      revokedAtMs: item.revokedAtMs == null ? null : Number(item.revokedAtMs),
      revocationReason: String(item.revocationReason ?? ''),
    }))
    .sort((left, right) => (
      left.trustEpoch - right.trustEpoch
      || left.keyId.localeCompare(right.keyId)
    ));
  return JSON.stringify({
    protocol: TRUST_FEED_PROTOCOL,
    issuedAtMs,
    expiresAtMs,
    signer: {
      algorithm: 'Ed25519',
      keyId: signer.keyId,
      trustEpoch: signer.trustEpoch,
      publicKeyFingerprint: signer.publicKeyFingerprint,
    },
    keys: normalizedKeys,
  });
}

export function verifyTrustFeedEnvelope(envelope, { nowMs = Date.now(), allowExpired = false } = {}) {
  try {
    if (envelope?.protocol !== TRUST_FEED_PROTOCOL || envelope?.algorithm !== 'Ed25519') return false;
    if (!Number.isSafeInteger(nowMs)) return false;
    const publicKeyDer = Buffer.from(String(envelope.publicKey ?? ''), 'base64');
    const fingerprint = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
    if (fingerprint !== envelope.publicKeyFingerprint) return false;
    const publicKey = crypto.createPublicKey({ key: publicKeyDer, type: 'spki', format: 'der' });
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    const payloadBytes = Buffer.from(String(envelope.payload ?? ''), 'utf8');
    if (!crypto.verify(null, payloadBytes, publicKey, Buffer.from(String(envelope.signature ?? ''), 'base64'))) {
      return false;
    }
    const payload = JSON.parse(payloadBytes.toString('utf8'));
    if (payload?.protocol !== TRUST_FEED_PROTOCOL) return false;
    if (!Number.isSafeInteger(payload.issuedAtMs) || !Number.isSafeInteger(payload.expiresAtMs)) return false;
    if (payload.expiresAtMs <= payload.issuedAtMs) return false;
    if (payload.issuedAtMs !== envelope.issuedAtMs || payload.expiresAtMs !== envelope.expiresAtMs) return false;
    if (payload.issuedAtMs > nowMs + TRUST_FEED_MAX_FUTURE_SKEW_MS) return false;
    if (!allowExpired && nowMs > payload.expiresAtMs) return false;
    if (
      payload.signer?.algorithm !== 'Ed25519'
      || payload.signer?.keyId !== envelope.keyId
      || Number(payload.signer?.trustEpoch) !== Number(envelope.trustEpoch)
      || payload.signer?.publicKeyFingerprint !== envelope.publicKeyFingerprint
    ) return false;
    const signerKey = Array.isArray(payload.keys)
      ? payload.keys.find((item) => (
        item.keyId === envelope.keyId
        && Number(item.trustEpoch) === Number(envelope.trustEpoch)
      ))
      : null;
    if (
      !signerKey
      || signerKey.status !== 'active'
      || signerKey.algorithm !== 'Ed25519'
      || signerKey.publicKey !== envelope.publicKey
      || signerKey.publicKeyFingerprint !== envelope.publicKeyFingerprint
    ) return false;
    return true;
  } catch {
    return false;
  }
}

export function verifyReleaseSignatureEnvelope(envelope) {
  try {
    if (envelope?.protocol !== SIGNATURE_PROTOCOL || envelope?.algorithm !== 'Ed25519') return false;
    const publicKeyDer = Buffer.from(String(envelope.publicKey ?? ''), 'base64');
    const fingerprint = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
    if (fingerprint !== envelope.publicKeyFingerprint) return false;
    const publicKey = crypto.createPublicKey({
      key: publicKeyDer,
      type: 'spki',
      format: 'der',
    });
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(
      null,
      Buffer.from(String(envelope.payload ?? ''), 'utf8'),
      publicKey,
      Buffer.from(String(envelope.signature ?? ''), 'base64'),
    );
  } catch {
    return false;
  }
}

export class ExtensionSigningStore {
  constructor({ db, signer = undefined, now = () => Date.now() } = {}) {
    if (!db) throw new Error('ExtensionSigningStore requires existing Marketplace SQLite connection');
    this.db = db;
    this.signer = signer === undefined ? loadConfiguredMarketplaceSigner() : signer;
    this.now = now;
    this.#ensureSchema();
    this.#prepare();
    if (this.signer) this.#registerConfiguredSigner();
  }

  #ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_trust_keys (
        key_id TEXT NOT NULL,
        trust_epoch INTEGER NOT NULL,
        algorithm TEXT NOT NULL,
        public_key TEXT NOT NULL,
        public_key_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        revocation_reason TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (key_id, trust_epoch)
      );

      CREATE TABLE IF NOT EXISTS extension_release_signatures (
        kind TEXT NOT NULL,
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        key_id TEXT NOT NULL,
        trust_epoch INTEGER NOT NULL,
        public_key TEXT NOT NULL,
        public_key_fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL,
        signature TEXT NOT NULL,
        signed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (kind, namespace, name, version)
      );
    `);
  }

  #prepare() {
    this.s = {
      trustGet: this.db.prepare(`
        SELECT key_id AS keyId, trust_epoch AS trustEpoch, algorithm,
          public_key AS publicKey, public_key_fingerprint AS publicKeyFingerprint,
          status, created_at_ms AS createdAtMs, revoked_at_ms AS revokedAtMs,
          revocation_reason AS revocationReason
        FROM extension_trust_keys
        WHERE key_id = ? AND trust_epoch = ?
        LIMIT 1
      `),
      trustList: this.db.prepare(`
        SELECT key_id AS keyId, trust_epoch AS trustEpoch, algorithm,
          public_key AS publicKey, public_key_fingerprint AS publicKeyFingerprint,
          status, created_at_ms AS createdAtMs, revoked_at_ms AS revokedAtMs,
          revocation_reason AS revocationReason
        FROM extension_trust_keys
        ORDER BY trust_epoch DESC, key_id ASC
      `),
      trustInsert: this.db.prepare(`
        INSERT INTO extension_trust_keys (
          key_id, trust_epoch, algorithm, public_key, public_key_fingerprint,
          status, created_at_ms
        ) VALUES (
          @keyId, @trustEpoch, 'Ed25519', @publicKey, @publicKeyFingerprint,
          'active', @createdAtMs
        )
      `),
      trustRevoke: this.db.prepare(`
        UPDATE extension_trust_keys
        SET status = 'revoked', revoked_at_ms = @revokedAtMs,
          revocation_reason = @revocationReason
        WHERE key_id = @keyId AND trust_epoch = @trustEpoch AND status = 'active'
      `),
      get: this.db.prepare(`
        SELECT algorithm, key_id AS keyId, trust_epoch AS trustEpoch,
          public_key AS publicKey, public_key_fingerprint AS publicKeyFingerprint,
          payload, signature, signed_at_ms AS signedAtMs
        FROM extension_release_signatures
        WHERE kind = ? AND namespace = ? AND name = ? AND version = ?
        LIMIT 1
      `),
      insert: this.db.prepare(`
        INSERT INTO extension_release_signatures (
          kind, namespace, name, version, algorithm, key_id, trust_epoch,
          public_key, public_key_fingerprint, payload, signature, signed_at_ms
        ) VALUES (
          @kind, @namespace, @name, @version, 'Ed25519', @keyId, @trustEpoch,
          @publicKey, @publicKeyFingerprint, @payload, @signature, @signedAtMs
        )
      `),
    };
  }

  #registerConfiguredSigner() {
    const existing = this.s.trustGet.get(this.signer.keyId, this.signer.trustEpoch);
    if (existing) {
      if (
        existing.algorithm !== 'Ed25519'
        || existing.publicKey !== this.signer.publicKey
        || existing.publicKeyFingerprint !== this.signer.publicKeyFingerprint
      ) {
        throw new ExtensionSigningStoreError(
          'TRUST_KEY_MATERIAL_CONFLICT',
          'configured key id/trust epoch already exists with different key material',
        );
      }
      if (existing.status !== 'active') {
        throw new ExtensionSigningStoreError(
          'TRUST_KEY_REVOKED',
          'configured signing key is already revoked',
        );
      }
      return;
    }
    this.s.trustInsert.run({
      keyId: this.signer.keyId,
      trustEpoch: this.signer.trustEpoch,
      publicKey: this.signer.publicKey,
      publicKeyFingerprint: this.signer.publicKeyFingerprint,
      createdAtMs: this.now(),
    });
  }

  listTrustKeys() {
    return this.s.trustList.all().map((row) => ({
      protocol: SIGNATURE_PROTOCOL,
      algorithm: row.algorithm,
      keyId: row.keyId,
      trustEpoch: Number(row.trustEpoch),
      publicKey: row.publicKey,
      publicKeyFingerprint: row.publicKeyFingerprint,
      status: row.status,
      createdAtMs: Number(row.createdAtMs),
      revokedAtMs: row.revokedAtMs == null ? null : Number(row.revokedAtMs),
      revocationReason: row.revocationReason || '',
    }));
  }

  revokeTrustKey({ keyId: rawKeyId, trustEpoch: rawTrustEpoch, reason = '' }) {
    const normalizedKeyId = keyId(rawKeyId);
    const epoch = positiveEpoch(rawTrustEpoch);
    if (
      this.signer
      && this.signer.keyId === normalizedKeyId
      && this.signer.trustEpoch === epoch
    ) {
      throw new ExtensionSigningStoreError(
        'ACTIVE_SIGNER_REVOCATION_REQUIRES_ROTATION',
        'rotate to a new managed signer before revoking the currently configured trust key',
      );
    }
    const existing = this.s.trustGet.get(normalizedKeyId, epoch);
    if (!existing) {
      throw new ExtensionSigningStoreError('TRUST_KEY_NOT_FOUND', 'trust key was not found');
    }
    if (existing.status === 'revoked') {
      throw new ExtensionSigningStoreError('TRUST_KEY_ALREADY_REVOKED', 'trust key is already revoked');
    }
    const revokedAtMs = this.now();
    this.s.trustRevoke.run({
      keyId: normalizedKeyId,
      trustEpoch: epoch,
      revokedAtMs,
      revocationReason: String(reason ?? '').trim().slice(0, 4000),
    });
    return this.listTrustKeys().find(
      (item) => item.keyId === normalizedKeyId && item.trustEpoch === epoch,
    );
  }

  getTrustedSignature(input) {
    const signature = this.getSignature(input);
    if (!signature) return null;
    const trust = this.s.trustGet.get(signature.keyId, signature.trustEpoch);
    if (
      !trust
      || trust.status !== 'active'
      || trust.algorithm !== signature.algorithm
      || trust.publicKey !== signature.publicKey
      || trust.publicKeyFingerprint !== signature.publicKeyFingerprint
      || !verifyReleaseSignatureEnvelope(signature)
    ) {
      return null;
    }
    return signature;
  }

  trustFeed({ ttlMs = undefined } = {}) {
    if (!this.signer) {
      throw new ExtensionSigningStoreError('SIGNING_KEY_REQUIRED', 'managed Marketplace signing key is not configured');
    }
    const issuedAtMs = this.now();
    const configuredTtl = ttlMs
      ?? process.env.FABUSHI_MARKETPLACE_TRUST_FEED_TTL_MS
      ?? DEFAULT_TRUST_FEED_TTL_MS;
    const expiresAtMs = issuedAtMs + trustFeedTtlMs(configuredTtl);
    const payload = canonicalTrustFeedPayload({
      signer: this.signer,
      keys: this.listTrustKeys(),
      issuedAtMs,
      expiresAtMs,
    });
    const signature = crypto.sign(
      null,
      Buffer.from(payload, 'utf8'),
      this.signer.privateKey,
    ).toString('base64');
    const envelope = {
      protocol: TRUST_FEED_PROTOCOL,
      algorithm: 'Ed25519',
      keyId: this.signer.keyId,
      trustEpoch: this.signer.trustEpoch,
      publicKey: this.signer.publicKey,
      publicKeyFingerprint: this.signer.publicKeyFingerprint,
      issuedAtMs,
      expiresAtMs,
      payload,
      signature,
    };
    if (!verifyTrustFeedEnvelope(envelope, { nowMs: issuedAtMs })) {
      throw new ExtensionSigningStoreError('TRUST_FEED_SELF_CHECK_FAILED', 'trust feed signature self-verification failed');
    }
    return envelope;
  }

  currentTrust() {
    if (!this.signer) {
      return {
        configured: false,
        protocol: SIGNATURE_PROTOCOL,
      };
    }
    return {
      configured: true,
      protocol: SIGNATURE_PROTOCOL,
      algorithm: 'Ed25519',
      keyId: this.signer.keyId,
      trustEpoch: this.signer.trustEpoch,
      publicKey: this.signer.publicKey,
      publicKeyFingerprint: this.signer.publicKeyFingerprint,
    };
  }

  getSignature(input) {
    const key = releaseKey(input);
    return publicEnvelope(this.s.get.get(key.kind, key.namespace, key.name, key.version));
  }

  signRelease({ descriptor, descriptorDigest, artifacts }) {
    const key = releaseKey({
      kind: descriptor?.identity?.kind,
      namespace: descriptor?.identity?.namespace,
      name: descriptor?.identity?.name,
      version: descriptor?.release?.version,
    });
    const payload = canonicalReleaseSignaturePayload({
      signer: this.signer,
      descriptor,
      descriptorDigest,
      artifacts,
    });
    const existing = this.getSignature(key);
    if (existing) {
      if (
        existing.keyId === this.signer?.keyId
        && existing.trustEpoch === this.signer?.trustEpoch
        && existing.payload === payload
        && verifyReleaseSignatureEnvelope(existing)
      ) {
        return existing;
      }
      throw new ExtensionSigningStoreError(
        'SIGNATURE_CONFLICT',
        'release already has an immutable signature from different trust material',
      );
    }

    const signature = crypto.sign(
      null,
      Buffer.from(payload, 'utf8'),
      this.signer.privateKey,
    ).toString('base64');
    const envelope = {
      protocol: SIGNATURE_PROTOCOL,
      algorithm: 'Ed25519',
      keyId: this.signer.keyId,
      trustEpoch: this.signer.trustEpoch,
      publicKey: this.signer.publicKey,
      publicKeyFingerprint: this.signer.publicKeyFingerprint,
      payload,
      signature,
      signedAtMs: this.now(),
    };
    if (!verifyReleaseSignatureEnvelope(envelope)) {
      throw new ExtensionSigningStoreError('SIGNATURE_SELF_CHECK_FAILED', 'release signature self-verification failed');
    }
    this.s.insert.run({
      ...key,
      keyId: envelope.keyId,
      trustEpoch: envelope.trustEpoch,
      publicKey: envelope.publicKey,
      publicKeyFingerprint: envelope.publicKeyFingerprint,
      payload: envelope.payload,
      signature: envelope.signature,
      signedAtMs: envelope.signedAtMs,
    });
    return envelope;
  }
}
