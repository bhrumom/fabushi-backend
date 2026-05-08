function base64UrlEncode(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeToArray(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4 === 2 ? '==' : base64.length % 4 === 3 ? '=' : '';
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

async function derivePbkdf2(password, saltBytes, iterations = 100000) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

async function createPasswordHash(password) {
  const salt = randomBytes(16);
  const iterations = 100000;
  const hashBytes = await derivePbkdf2(password, salt, iterations);
  return {
    passwordHash: base64UrlEncode(hashBytes),
    salt: base64UrlEncode(salt),
    iterations,
    algo: 'PBKDF2-SHA256'
  };
}

async function verifyPassword(password, user) {
  try {
    if (user && user.passwordHash && user.salt) {
      const saltBytes = base64UrlDecodeToArray(user.salt);
      const iterations = user.iterations || 100000;
      const hashBytes = await derivePbkdf2(password, saltBytes, iterations);
      return base64UrlEncode(hashBytes) === user.passwordHash;
    }
    if (user && user.password) {
      const encoder = new TextEncoder();
      const data = encoder.encode(password);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
      return hex === user.password;
    }
    return false;
  } catch (error) {
    console.error('Password verification crashed:', error.stack);
    return false;
  }
}

function normalizeTokenIdentity(identity) {
  if (identity && typeof identity === 'object') {
    const userId = identity.id ?? identity.user_id ?? identity.userId;
    return {
      userId: userId === undefined || userId === null ? undefined : Number(userId),
      username: identity.username ? String(identity.username) : undefined
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
      if (user?.id !== undefined && user?.id !== null) {
        userId = Number(user.id);
      }
    } catch (error) {
      console.warn('generateToken userId lookup skipped:', error?.message || error);
    }
  }
  const payload = {
    exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60),
    jti: crypto.randomUUID()
  };
  if (Number.isFinite(userId)) payload.userId = userId;
  if (username) payload.username = username;

  const enc = new TextEncoder();
  const secret = (env && (env.JWT_SECRET || (env.vars && env.vars.JWT_SECRET))) || 'dev-secret';
  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const data = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${base64UrlEncode(signature)}`;
}

async function verifyToken(token, env) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const enc = new TextEncoder();
    const secret = (env && (env.JWT_SECRET || (env.vars && env.vars.JWT_SECRET))) || 'dev-secret';
    const data = `${headerB64}.${payloadB64}`;
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = base64UrlDecodeToArray(sigB64);
    const valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(data));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeToArray(payloadB64)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.userId !== undefined && payload.userId !== null) {
      payload.userId = Number(payload.userId);
    }
    return payload;
  } catch {
    return null;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

export {
  base64UrlEncode,
  base64UrlDecodeToArray,
  randomBytes,
  derivePbkdf2,
  createPasswordHash,
  verifyPassword,
  generateToken,
  verifyToken,
  jsonResponse
};