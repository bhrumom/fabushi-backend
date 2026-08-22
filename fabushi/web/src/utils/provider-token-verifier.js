const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const JWKS_CACHE = new Map();

function base64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  if (normalized.length % 4 === 1) throw new Error('invalid base64url');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const decoded = atob(normalized + padding);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function decodeJsonPart(value) {
  const decoded = new TextDecoder().decode(base64UrlToBytes(value));
  const parsed = JSON.parse(decoded);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid identity token JSON');
  return parsed;
}

async function fetchJwks(url) {
  const cached = JWKS_CACHE.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`provider JWKS fetch failed: ${response.status}`);
  const body = await response.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  if (keys.length === 0) throw new Error('provider JWKS response contained no keys');

  const cacheControl = response.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSeconds = Math.min(21600, Math.max(60, Number(maxAgeMatch?.[1]) || 300));
  JWKS_CACHE.set(url, { keys, expiresAt: Date.now() + maxAgeSeconds * 1000 });
  return keys;
}

async function verifyRs256Jwt(jwt, { jwksUrl, issuer, audiences }) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('malformed identity token');
  const [encodedHeader, encodedPayload] = parts;
  if (!encodedHeader || !encodedPayload || !parts[2]) throw new Error('malformed identity token');
  const header = decodeJsonPart(encodedHeader);
  const payload = decodeJsonPart(encodedPayload);

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new Error('unsupported identity token algorithm');
  }
  const keys = await fetchJwks(jwksUrl);
  let jwk = keys.find((entry) => entry.kid === header.kid && entry.kty === 'RSA' && (!entry.alg || entry.alg === 'RS256'));
  if (!jwk) {
    JWKS_CACHE.delete(jwksUrl);
    const refreshed = await fetchJwks(jwksUrl);
    jwk = refreshed.find((entry) => entry.kid === header.kid && entry.kty === 'RSA' && (!entry.alg || entry.alg === 'RS256'));
  }
  if (!jwk) throw new Error('identity token signing key not found');
  return verifyWithJwk(jwk, parts, payload, { issuer, audiences });
}

async function verifyWithJwk(jwk, parts, payload, { issuer, audiences }) {
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new Error('identity token signature invalid');

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== issuer) throw new Error('identity token issuer invalid');
  const allowedAudiences = new Set((audiences || []).map(String).map((v) => v.trim()).filter(Boolean));
  const tokenAudiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud || '')];
  if (allowedAudiences.size === 0 || !tokenAudiences.some((aud) => allowedAudiences.has(aud))) {
    throw new Error('identity token audience invalid');
  }
  const exp = Number(payload.exp);
  const iat = Number(payload.iat);
  if (!Number.isSafeInteger(exp) || exp <= now) throw new Error('identity token expired');
  if (!Number.isSafeInteger(iat) || iat > now + 60 || iat < now - 24 * 60 * 60) {
    throw new Error('identity token issued-at time invalid');
  }
  const subject = String(payload.sub || '');
  if (!subject || subject.length > 128) throw new Error('identity token subject invalid');
  return payload;
}

function constantTimeTextEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ''));
  const b = new TextEncoder().encode(String(right || ''));
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyAppleIdentityToken(identityToken, env, expectedNonce = '') {
  const audiences = [env.APPLE_CLIENT_ID, env.APPLE_SERVICE_ID, env.APPLE_BUNDLE_ID].filter(Boolean);
  if (audiences.length === 0) throw new Error('Apple identity verification is not configured');
  const payload = await verifyRs256Jwt(identityToken, {
    jwksUrl: APPLE_JWKS_URL,
    issuer: 'https://appleid.apple.com',
    audiences,
  });
  if (expectedNonce) {
    if (!payload.nonce || !constantTimeTextEqual(payload.nonce, expectedNonce)) throw new Error('Apple nonce mismatch');
  }
  if (payload.email && payload.email_verified !== undefined && !['true', true].includes(payload.email_verified)) {
    throw new Error('Apple email is not verified');
  }
  return payload;
}

export async function verifyFirebaseIdentityToken(idToken, env) {
  const projectId = String(env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || '').trim();
  if (!projectId) throw new Error('Firebase identity verification is not configured');
  const payload = await verifyRs256Jwt(idToken, {
    jwksUrl: FIREBASE_JWKS_URL,
    issuer: `https://securetoken.google.com/${projectId}`,
    audiences: [projectId],
  });
  if (!payload.user_id && !payload.sub) throw new Error('Firebase user identity missing');
  const now = Math.floor(Date.now() / 1000);
  const authTime = Number(payload.auth_time);
  if (!Number.isSafeInteger(authTime) || authTime > now + 60) throw new Error('Firebase auth_time invalid');
  return payload;
}
