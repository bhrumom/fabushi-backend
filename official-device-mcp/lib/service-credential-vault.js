import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VAULT_ALGORITHM = "A256GCM";
const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const MAX_REFRESH_TOKEN_CHARS = 8 * 1024;
const MAX_BINDING_CHARS = 512;
const PURPOSE = "official-device-mcp-service-refresh/v1";

export class ServiceCredentialVaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ServiceCredentialVaultError";
    this.code = code;
  }
}

function boundedString(value, name, max = MAX_BINDING_CHARS) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max || /[\r\n\0]/u.test(normalized)) {
    throw new ServiceCredentialVaultError("invalid_service_binding", `${name} is invalid.`);
  }
  return normalized;
}

function normalizeKey(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== KEY_BYTES) {
      throw new ServiceCredentialVaultError("invalid_vault_key", "Service credential vault key must be exactly 32 bytes.");
    }
    return Buffer.from(value);
  }
  const encoded = String(value || "").trim();
  if (!encoded || /\s/u.test(encoded)) {
    throw new ServiceCredentialVaultError("missing_vault_key", "Service credential vault key is required.");
  }
  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64url");
  } catch {
    throw new ServiceCredentialVaultError("invalid_vault_key", "Service credential vault key must be base64url encoded.");
  }
  if (decoded.length !== KEY_BYTES || decoded.toString("base64url") !== encoded.replace(/=+$/u, "")) {
    throw new ServiceCredentialVaultError("invalid_vault_key", "Service credential vault key must decode to exactly 32 bytes.");
  }
  return decoded;
}

function normalizeBinding(binding = {}) {
  return {
    accountId: boundedString(binding.accountId, "accountId", 200),
    connectionId: boundedString(binding.connectionId, "connectionId", 200),
    delegationId: boundedString(binding.delegationId, "delegationId", 200),
    externalClientId: boundedString(binding.externalClientId, "externalClientId", 256),
    resource: boundedString(binding.resource, "resource", 512),
  };
}

function additionalAuthenticatedData(binding) {
  const normalized = normalizeBinding(binding);
  return Buffer.from(JSON.stringify({
    purpose: PURPOSE,
    accountId: normalized.accountId,
    connectionId: normalized.connectionId,
    delegationId: normalized.delegationId,
    externalClientId: normalized.externalClientId,
    resource: normalized.resource,
  }), "utf8");
}

function keyId(key) {
  return createHash("sha256").update(key).digest("base64url").slice(0, 22);
}

function decodeEnvelopeBytes(value, name, maxBytes) {
  const encoded = String(value || "");
  if (!encoded || encoded.length > maxBytes * 2) {
    throw new ServiceCredentialVaultError("invalid_vault_envelope", `Encrypted ${name} is invalid.`);
  }
  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64url");
  } catch {
    throw new ServiceCredentialVaultError("invalid_vault_envelope", `Encrypted ${name} is invalid.`);
  }
  if (!decoded.length || decoded.length > maxBytes) {
    throw new ServiceCredentialVaultError("invalid_vault_envelope", `Encrypted ${name} is invalid.`);
  }
  return decoded;
}

export function createServiceCredentialVault({ key = process.env.FABUSHI_OFFICIAL_MCP_SERVICE_VAULT_KEY } = {}) {
  const normalizedKey = normalizeKey(key);
  const kid = keyId(normalizedKey);

  return Object.freeze({
    keyId: kid,

    seal(refreshToken, binding) {
      const token = String(refreshToken || "").trim();
      if (token.length < 24 || token.length > MAX_REFRESH_TOKEN_CHARS || /[\r\n\0]/u.test(token)) {
        throw new ServiceCredentialVaultError("invalid_service_refresh_token", "Service refresh credential is invalid.");
      }
      const aad = additionalAuthenticatedData(binding);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(CIPHER, normalizedKey, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Object.freeze({
        version: 1,
        algorithm: VAULT_ALGORITHM,
        keyId: kid,
        iv: iv.toString("base64url"),
        tag: tag.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      });
    },

    open(envelope, binding) {
      if (!envelope || envelope.version !== 1 || envelope.algorithm !== VAULT_ALGORITHM || envelope.keyId !== kid) {
        throw new ServiceCredentialVaultError("vault_key_mismatch", "Encrypted service credential cannot be opened by the active vault key.");
      }
      try {
        const iv = decodeEnvelopeBytes(envelope.iv, "iv", IV_BYTES);
        if (iv.length !== IV_BYTES) throw new Error("invalid iv");
        const tag = decodeEnvelopeBytes(envelope.tag, "tag", 16);
        if (tag.length !== 16) throw new Error("invalid tag");
        const ciphertext = decodeEnvelopeBytes(envelope.ciphertext, "ciphertext", MAX_REFRESH_TOKEN_CHARS * 2);
        const decipher = createDecipheriv(CIPHER, normalizedKey, iv);
        decipher.setAAD(additionalAuthenticatedData(binding));
        decipher.setAuthTag(tag);
        const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
        if (token.length < 24 || token.length > MAX_REFRESH_TOKEN_CHARS || /[\r\n\0]/u.test(token)) {
          throw new Error("invalid plaintext");
        }
        return token;
      } catch (error) {
        if (error instanceof ServiceCredentialVaultError) throw error;
        throw new ServiceCredentialVaultError("service_credential_decrypt_failed", "Encrypted service credential failed authentication.");
      }
    },
  });
}
