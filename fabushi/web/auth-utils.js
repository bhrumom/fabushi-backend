function base64UrlEncode(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeToArray(base64url) {
  const normalized = String(base64url || '');
  const base64 = normalized.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = base64.length % 4;
  const pad = remainder === 2 ? '==' : remainder === 3 ? '=' : remainder === 0 ? '' : null;
  if (pad === null) throw new Error('invalid base64url');
  const str = atob(base64 + pad);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) bytes[i] = str.charCodeAt(i);
  return bytes;
}

function randomBytes(size = 16) {
  const array = new Uint8Array(size);
  crypto.getRandomValues(array);
  return array;
}

function timingSafeEqualBytes(left, right) {
  const a = left instanceof Uint8Array ? left : new Uint8Array(left);
  const b = right instanceof Uint8Array ? right : new Uint8Array(right);
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < a.byteLength; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

function resolveJwtSecret(env) {
  // JWT_SIGNING_SECRET is the production key. JWT_SECRET remains a temporary
  // compatibility alias for isolated tests/older development environments only;
  // deployment preflight requires JWT_SIGNING_SECRET so a stale plaintext
  // JWT_SECRET binding can never be selected by deployed hardened Workers.
  const secret = String(
    env?.JWT_SIGNING_SECRET ||
    env?.vars?.JWT_SIGNING_SECRET ||
    env?.JWT_SECRET ||
    env?.vars?.JWT_SECRET ||
    '',
  ).trim();
  const weak = new Set([
    'dev-secret',
    'secret',
    'changeme',
    'change-me',
    'dev_secret_key_2025',
    'prod_secret_key_2025_ombhrum_fabushi',
  ]);
  if (secret.length < 32 || weak.has(secret.toLowerCase())) {
    throw new Error('JWT signing secret is missing or insecure; configure JWT_SIGNING_SECRET with at least 32 characters');
  }
  return secret;
}

async function derivePbkdf2(password, saltBytes, iterations = 210000) {
  const enc = new TextEncoder();
  const normalizedIterations = Math.max(100000, Number(iterations) || 210000);
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: normalizedIterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

async function createPasswordHash(password) {
  const normalized = String(password || '');
  if (normalized.length < 8 || normalized.length > 1024) {
    throw new Error('password must be between 8 and 1024 characters');
  }
  const salt = randomBytes(16);
  const iterations = 210000;
  const hashBytes = await derivePbkdf2(normalized, salt, iterations);
  return {
    passwordHash: base64UrlEncode(hashBytes),
    salt: base64UrlEncode(salt),
    iterations,
    algo: 'PBKDF2-SHA256',
  };
}

async function verifyPassword(password, user) {
  try {
    if (!user?.passwordHash || !user?.salt) return false;
    const algo = String(user.algo || 'PBKDF2-SHA256').toUpperCase();
    if (algo !== 'PBKDF2-SHA256') return false;
    const saltBytes = base64UrlDecodeToArray(user.salt);
    const iterations = Math.max(100000, Number(user.iterations) || 100000);
    const hashBytes = await derivePbkdf2(password, saltBytes, iterations);
    const expected = base64UrlDecodeToArray(user.passwordHash);
    return timingSafeEqualBytes(hashBytes, expected);
  } catch (error) {
    console.error('Password verification failed safely:', error?.message || error);
    return false;
  }
}

function normalizeTokenIdentity(identity) {
  if (identity && typeof identity === 'object') {
    const userId = identity.id ?? identity.user_id ?? identity.userId;
    return {
      userId: userId === undefined || userId === null ? undefined : Number(userId),
      username: identity.username ? String(identity.username) : undefined,
    };
  }
  if (typeof identity === 'number') return { userId: identity };
  return { username: String(identity || '') };
}

async function generateToken(identity, env) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const normalized = normalizeTokenIdentity(identity);
  let { userId, username } = normalized;
  if (!Number.isFinite(userId) && username && env?.DB?.prepare) {
    try {
      const user = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (user?.id !== undefined && user?.id !== null) userId = Number(user.id);
    } catch (error) {
      console.warn('generateToken userId lookup skipped:', error?.message || error);
    }
  }
  if (!Number.isFinite(userId) && !username) throw new Error('cannot issue token without a stable user identity');

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'fabushi-api',
    aud: 'fabushi-clients',
    iat: now,
    nbf: now - 5,
    exp: now + (7 * 24 * 60 * 60),
    jti: crypto.randomUUID(),
    ver: 2,
  };
  if (Number.isFinite(userId)) payload.userId = userId;
  if (username) payload.username = username;

  const enc = new TextEncoder();
  const secret = resolveJwtSecret(env);
  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const data = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${base64UrlEncode(signature)}`;
}

async function verifyLegacyToken(token, env) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecodeToArray(headerB64)));
    if (header?.alg !== 'HS256' || (header.typ && header.typ !== 'JWT')) return null;

    const enc = new TextEncoder();
    const secret = resolveJwtSecret(env);
    const data = `${headerB64}.${payloadB64}`;
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlDecodeToArray(sigB64), enc.encode(data));
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeToArray(payloadB64)));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= now) return null;
    if (payload.nbf && Number(payload.nbf) > now + 30) return null;
    if (payload.iat && Number(payload.iat) > now + 30) return null;
    if (payload.iss && payload.iss !== 'fabushi-api') return null;
    if (payload.aud && payload.aud !== 'fabushi-clients') return null;
    if (!payload.username && (payload.userId === undefined || payload.userId === null)) return null;
    if (payload.userId !== undefined && payload.userId !== null) {
      payload.userId = Number(payload.userId);
      if (!Number.isFinite(payload.userId)) return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function verifyMahayanaAccessToken(token, env) {
  // The canonical account service issues RS256 access tokens. Legacy Fabushi
  // handlers still use this module, so ask the already-bound Mahayana service
  // to validate the token instead of teaching every legacy handler a second
  // JWT implementation. The service response is the authenticated identity;
  // no client-supplied claims are trusted here.
  if (!env?.MAHAYANA_PLATFORM || typeof env.MAHAYANA_PLATFORM.fetch !== 'function') {
    return null;
  }

  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecodeToArray(parts[0])));
    if (header?.alg !== 'RS256' || (header.typ && header.typ !== 'JWT')) return null;

    const response = await env.MAHAYANA_PLATFORM.fetch(
      new Request('https://mahayana-platform.internal/api/auth/user-info', {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      }),
    );
    if (!response.ok) return null;

    const payload = await response.json();
    const user = payload?.user && typeof payload.user === 'object' ? payload.user : {};
    const rawUserId = payload?.userId ?? payload?.id ?? user.userId ?? user.id;
    const rawUsername = payload?.username ?? user.username;
    const username = rawUsername ? String(rawUsername) : '';
    const numericUserId = rawUserId === undefined || rawUserId === null
      ? undefined
      : Number(rawUserId);
    const userId = Number.isSafeInteger(numericUserId) ? numericUserId : undefined;
    if (!username && userId === undefined) return null;

    return {
      iss: 'mahayana-platform',
      aud: 'mahayana-platform',
      ver: 3,
      userId,
      username: username || undefined,
      membership: payload?.membership ?? user.membership,
      isAdmin: Boolean(payload?.isAdmin ?? user.isAdmin),
      role: payload?.role ?? user.role,
      unlimitedUsage: Boolean(payload?.unlimitedUsage ?? user.unlimitedUsage),
      platformAccessToken: true,
    };
  } catch {
    return null;
  }
}

async function verifyToken(token, env) {
  return await verifyLegacyToken(token, env) || await verifyMahayanaAccessToken(token, env);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export {
  base64UrlEncode,
  base64UrlDecodeToArray,
  randomBytes,
  timingSafeEqualBytes,
  resolveJwtSecret,
  derivePbkdf2,
  createPasswordHash,
  verifyPassword,
  generateToken,
  verifyToken,
  jsonResponse,
};
