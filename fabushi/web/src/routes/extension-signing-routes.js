import { jsonResponse } from '../utils/response.js';

const DOMAIN = new TextEncoder().encode('fabushi.fabapp.manifest.v1\0');
const FABAPP_FIELDS = Object.freeze([
  'manifestVersion', 'packageClass', 'appId', 'publisherId', 'version',
  'displayName', 'entrypoint', 'runtime', 'minHostApi', 'offlineCore',
  'requestedCapabilities', 'networkPolicy', 'files',
]);
const SPKI_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
  0x70, 0x03, 0x21, 0x00,
]);

function fail(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
}

function base64urlDecode(value) {
  const normalized = String(value ?? '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    fail('INVALID_SIGNING_PUBLIC_KEY', 'signing public key is not valid base64url', 500);
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64urlEncode(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemPkcs8(value) {
  const text = String(value ?? '').trim().replace(/\\n/g, '\n');
  const match = text.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (!match) fail('INVALID_SIGNING_PRIVATE_KEY', 'managed signing key must be PKCS#8 PEM', 500);
  const binary = atob(match[1].replace(/\s+/g, ''));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('INVALID_FABAPP_MANIFEST', 'manifest numbers must be safe integers');
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',') + '}';
  }
  fail('INVALID_FABAPP_MANIFEST', 'manifest contains unsupported JSON value');
}

function validIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function validPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_FABAPP_MANIFEST', 'fabapp manifest must be an object');
  }
  const keys = Object.keys(raw);
  const expected = [...FABAPP_FIELDS].sort().join(',');
  if (keys.includes('signature') || keys.sort().join(',') !== expected) {
    fail('INVALID_FABAPP_MANIFEST', 'fabapp unsigned manifest fields are invalid');
  }
  if (raw.manifestVersion !== 1 || raw.packageClass !== 'catalog') {
    fail('INVALID_FABAPP_MANIFEST', 'unsupported fabapp manifest version/class');
  }
  if (!validIdentifier(raw.appId) || !validIdentifier(raw.publisherId)
      || typeof raw.version !== 'string'
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(raw.version)) {
    fail('INVALID_FABAPP_MANIFEST', 'fabapp identity/version is invalid');
  }
  if (typeof raw.displayName !== 'string' || !raw.displayName || raw.displayName.length > 160) {
    fail('INVALID_FABAPP_MANIFEST', 'fabapp displayName is invalid');
  }
  if (!validPath(raw.entrypoint) || raw.runtime !== 'web'
      || !Number.isSafeInteger(raw.minHostApi) || raw.minHostApi < 1
      || typeof raw.offlineCore !== 'boolean') {
    fail('INVALID_FABAPP_MANIFEST', 'fabapp runtime/host contract is invalid');
  }
  if (!Array.isArray(raw.requestedCapabilities) || raw.requestedCapabilities.length > 256) {
    fail('INVALID_FABAPP_MANIFEST', 'fabapp capabilities are invalid');
  }
  const capabilities = new Set();
  for (const capability of raw.requestedCapabilities) {
    if (typeof capability !== 'string'
        || !/^[A-Za-z0-9_.-]{1,128}$/.test(capability)
        || capabilities.has(capability)) {
      fail('INVALID_FABAPP_MANIFEST', 'fabapp capability is invalid or duplicated');
    }
    capabilities.add(capability);
  }
  const policy = raw.networkPolicy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || Object.keys(policy).sort().join(',') !== 'allowedOrigins,mode'
      || !['deny', 'allowlist'].includes(policy.mode)
      || !Array.isArray(policy.allowedOrigins)
      || policy.allowedOrigins.some((origin) => typeof origin !== 'string')) {
    fail('INVALID_FABAPP_MANIFEST', 'fabapp network policy is invalid');
  }
  if ((policy.mode === 'deny' && policy.allowedOrigins.length !== 0)
      || (raw.offlineCore && policy.mode !== 'deny')) {
    fail('INVALID_FABAPP_MANIFEST', 'offline fabapp network policy must deny network');
  }
  const files = raw.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)
      || Object.keys(files).length < 1 || Object.keys(files).length > 10000) {
    fail('INVALID_FABAPP_MANIFEST', 'fabapp file table is invalid');
  }
  for (const [path, item] of Object.entries(files)) {
    if (!validPath(path) || !item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).sort().join(',') !== 'bytes,mime,sha256'
        || !/^[0-9a-f]{64}$/.test(String(item.sha256 ?? ''))
        || !Number.isSafeInteger(item.bytes) || item.bytes < 0
        || typeof item.mime !== 'string'
        || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(item.mime)) {
      fail('INVALID_FABAPP_MANIFEST', 'invalid fabapp file declaration: ' + path);
    }
  }
  if (!files[raw.entrypoint] || files[raw.entrypoint].mime !== 'text/html') {
    fail('INVALID_FABAPP_MANIFEST', 'fabapp entrypoint must be declared as text/html');
  }
  return JSON.parse(JSON.stringify(raw));
}

function signingConfig(env) {
  const privateKey = String(env.FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY ?? '').trim();
  const publicRaw = String(env.FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW ?? '').trim();
  const keyId = String(env.FABUSHI_MARKETPLACE_SIGNING_KEY_ID ?? '').trim();
  const epoch = Number(env.FABUSHI_MARKETPLACE_TRUST_EPOCH);
  const reviewToken = String(env.FABUSHI_MARKETPLACE_REVIEW_TOKEN ?? '').trim();
  if (!privateKey || !publicRaw || !keyId || !reviewToken
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId)
      || !Number.isSafeInteger(epoch) || epoch < 1) {
    fail('SIGNING_CONFIGURATION_REQUIRED', 'production Marketplace signing configuration is incomplete', 503);
  }
  const rawKey = base64urlDecode(publicRaw);
  if (rawKey.length !== 32) {
    fail('INVALID_SIGNING_PUBLIC_KEY', 'managed Ed25519 public key must be 32 raw bytes', 503);
  }
  return { privateKey, publicRaw, rawKey, keyId, epoch, reviewToken };
}

async function fingerprint(rawKey) {
  const spki = new Uint8Array(SPKI_ED25519_PREFIX.length + rawKey.length);
  spki.set(SPKI_ED25519_PREFIX);
  spki.set(rawKey, SPKI_ED25519_PREFIX.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', spki));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function constantTimeTokenMatches(actual, expected) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(actual ?? ''))),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function signerTrust(env) {
  const config = signingConfig(env);
  return {
    config,
    trust: {
      algorithm: 'Ed25519',
      keyId: config.keyId,
      trustEpoch: config.epoch,
      publicKeyFingerprint: await fingerprint(config.rawKey),
      rawPublicKeyBase64URL: config.publicRaw,
    },
  };
}

async function signManifest(env, rawManifest) {
  const manifest = validateManifest(rawManifest);
  const { config, trust } = await signerTrust(env);
  const canonical = new TextEncoder().encode(canonicalJson(manifest));
  const payload = new Uint8Array(DOMAIN.length + canonical.length);
  payload.set(DOMAIN);
  payload.set(canonical, DOMAIN.length);
  let privateKey;
  let publicKey;
  try {
    privateKey = await crypto.subtle.importKey(
      'pkcs8', pemPkcs8(config.privateKey), { name: 'Ed25519' }, false, ['sign'],
    );
    publicKey = await crypto.subtle.importKey(
      'raw', config.rawKey, { name: 'Ed25519' }, false, ['verify'],
    );
  } catch {
    fail('INVALID_SIGNING_KEY', 'managed Ed25519 signing key could not be imported', 503);
  }
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, payload));
  const verified = await crypto.subtle.verify('Ed25519', publicKey, signature, payload);
  if (!verified) fail('SIGNATURE_SELF_CHECK_FAILED', 'managed signing key/public key mismatch', 503);
  return {
    manifest: {
      ...manifest,
      signature: {
        algorithm: 'Ed25519',
        keyId: config.keyId,
        value: base64urlEncode(signature),
      },
    },
    trust,
  };
}

export async function routeExtensionSigningRequest({ pathname, method, request, env }) {
  if (pathname === '/v1/extensions/trust' && method === 'GET') {
    try {
      const { trust } = await signerTrust(env);
      return jsonResponse({ trust });
    } catch (error) {
      return jsonResponse({ error: error.code || 'SIGNING_ERROR', message: error.message }, error.status || 500);
    }
  }
  if (pathname === '/v1/extensions/review/fabapp/sign' && method === 'POST') {
    try {
      const { config } = await signerTrust(env);
      if (!await constantTimeTokenMatches(
        request.headers.get('x-fabushi-marketplace-review-token'),
        config.reviewToken,
      )) {
        return jsonResponse({ error: 'REVIEW_AUTH_REQUIRED' }, 403);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON' }, 400);
      }
      const signed = await signManifest(env, body?.manifest);
      return jsonResponse(signed);
    } catch (error) {
      return jsonResponse({ error: error.code || 'SIGNING_ERROR', message: error.message }, error.status || 500);
    }
  }
  return null;
}

export const __test = Object.freeze({
  canonicalJson,
  validateManifest,
  signManifest,
});
