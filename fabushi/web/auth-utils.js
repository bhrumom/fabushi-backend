// 认证工具函数 - 供 worker.js 和 alipay-login-functions.js 共享使用

// Base64URL 工具
function base64UrlEncode(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeToArray(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4 === 2 ? '==' : base64.length % 4 === 3 ? '=' : '';
  const str = atob(base64 + pad);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

// 随机盐
function randomBytes(size = 16) {
  const array = new Uint8Array(size);
  crypto.getRandomValues(array);
  return array;
}

// PBKDF2 派生
async function derivePbkdf2(password, saltBytes, iterations = 100000) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

// 新的密码哈希：PBKDF2 + Salt（同时兼容旧版 SHA-256 存量用户）
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

// 验证密码（支持 PBKDF2 和 SHA-256）
async function verifyPassword(password, user) {
  try {
    // 优先检查新版 PBKDF2 哈希
    if (user && user.passwordHash && user.salt) {
      console.log("Attempting to verify password with new PBKDF2 hash.");
      const saltBytes = base64UrlDecodeToArray(user.salt);
      const iterations = user.iterations || 100000;
      const hashBytes = await derivePbkdf2(password, saltBytes, iterations);
      const computed = base64UrlEncode(hashBytes);
      const result = computed === user.passwordHash;
      console.log(`PBKDF2 comparison result: ${result}`);
      if (!result) console.error("PBKDF2 comparison failed.");
      return result;
    }
    // 兼容旧版（纯 SHA-256 十六进制），用于平滑迁移
    if (user && user.password) {
      console.log("Attempting to verify password with old SHA-256 hash.");
      const encoder = new TextEncoder();
      const data = encoder.encode(password);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      const result = hex === user.password;
      console.log(`SHA-256 comparison result: ${result}`);
      if (!result) console.error("SHA-256 comparison failed.");
      return result;
    }
    console.error("User object has no recognizable password format:", JSON.stringify(user));
    return false;
  } catch (e) {
    console.error('Password verification crashed:', e.stack);
    return false;
  }
}

// 如果用户为旧版哈希且验证通过，则升级为 PBKDF2
async function upgradePasswordIfNeeded(password, username, user, env) {
  if (user && user.password && (!user.passwordHash || !user.salt)) {
    const updated = { ...user };
    const { passwordHash, salt, iterations, algo } = await createPasswordHash(password);
    delete updated.password;
    updated.passwordHash = passwordHash;
    updated.salt = salt;
    updated.iterations = iterations;
    updated.algo = algo;
    await env.USERS_KV.put(`user:${username}`, JSON.stringify(updated));
    return updated;
  }
  return user;
}

// JWT 工具函数
async function generateToken(username, env) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    username,
    exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), // 7天有效期
    jti: crypto.randomUUID() // 增加一个唯一的ID，确保每次生成的token都不同
  };
  const enc = new TextEncoder();
  const secret = (env && (env.JWT_SECRET || (env.vars && env.vars.JWT_SECRET))) || 'dev-secret';

  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const data = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const sigB64 = base64UrlEncode(signature);

  return `${data}.${sigB64}`;
}

async function verifyToken(token, env) {
  try {
    console.log('🔍 verifyToken: 开始验证');
    const parts = token.split('.');
    if (parts.length !== 3) {
      console.log('❌ verifyToken: token 格式错误，parts.length =', parts.length);
      return null;
    }
    const [headerB64, payloadB64, sigB64] = parts;
    const enc = new TextEncoder();
    const secret = (env && (env.JWT_SECRET || (env.vars && env.vars.JWT_SECRET))) || 'dev-secret';
    console.log('🔑 verifyToken: 使用 secret:', secret ? secret.substring(0, 20) + '...' : 'null');

    const data = `${headerB64}.${payloadB64}`;
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = base64UrlDecodeToArray(sigB64);
    const valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(data));
    console.log('🔐 verifyToken: 签名验证结果:', valid);
    if (!valid) {
      console.log('❌ verifyToken: 签名验证失败');
      return null;
    }

    // 使用 base64UrlDecodeToArray 解码，然后转换为 UTF-8 字符串
    const payloadBytes = base64UrlDecodeToArray(payloadB64);
    const payloadStr = new TextDecoder().decode(payloadBytes);
    const payload = JSON.parse(payloadStr);
    console.log('📦 verifyToken: payload =', payload);
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.log('❌ verifyToken: token 已过期, exp:', payload.exp, 'now:', now);
      return null;
    }
    console.log('✅ verifyToken: 验证成功');
    return payload;
  } catch (e) {
    console.log('❌ verifyToken: 异常:', e.message);
    return null;
  }
}

// JSON响应工具函数
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

// 导出所有函数供其他模块使用
export {
  base64UrlEncode,
  base64UrlDecodeToArray,
  randomBytes,
  derivePbkdf2,
  createPasswordHash,
  verifyPassword,
  upgradePasswordIfNeeded,
  generateToken,
  verifyToken,
  jsonResponse
};