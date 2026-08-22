import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { APPLE_IAP_PRODUCTS } from '../config/constants.js';
import { verifyAppleTransactionJws } from '../security/apple-jws-verifier.js';

const PERMANENT_VALID_TO = '9999-12-31T23:59:59.999Z';

function config(env) {
  return {
    issuerId: String(env.APPLE_ISSUER_ID || '').trim(),
    keyId: String(env.APPLE_KEY_ID || '').trim(),
    privateKey: String(env.APPLE_PRIVATE_KEY || '').trim().replace(/\\n/g, '\n'),
    bundleId: String(env.APPLE_BUNDLE_ID || '').trim(),
  };
}

function b64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function appleJwt(env) {
  const c = config(env);
  if (!c.issuerId || !c.keyId || !c.privateKey || !c.bundleId) throw new Error('Apple IAP is not configured');
  const derText = c.privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, '');
  const der = Uint8Array.from(atob(derText), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'ES256', kid: c.keyId, typ: 'JWT' })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    iss: c.issuerId, iat: now, exp: now + 300, aud: 'appstoreconnect-v1', bid: c.bundleId,
  })));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return `${input}.${b64url(signature)}`;
}

async function fetchTransaction(transactionId, env, options = {}) {
  const token = await appleJwt(env);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const endpoints = [
    {
      url: `https://api.storekit.apple.com/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
      environment: 'Production',
    },
    {
      url: `https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
      environment: 'Sandbox',
    },
  ];
  const fetchImpl = options.fetchImpl || fetch;
  const verifyJws = options.verifyJws || verifyAppleTransactionJws;
  let lastStatus = 0;
  for (const endpoint of endpoints) {
    const response = await fetchImpl(endpoint.url, { method: 'GET', headers, redirect: 'error' });
    lastStatus = response.status;
    if ([401, 404].includes(response.status)) continue;
    if (!response.ok) throw new Error(`Apple transaction lookup failed: ${response.status}`);
    const body = await response.json();
    if (!body?.signedTransactionInfo) throw new Error('Apple response omitted signedTransactionInfo');
    const transaction = await verifyJws(body.signedTransactionInfo);
    if (transaction.environment !== endpoint.environment) {
      throw new Error(`Apple transaction environment mismatch: expected ${endpoint.environment}`);
    }
    return transaction;
  }
  throw new Error(`Apple transaction not found (${lastStatus})`);
}

async function userForClaims(db, claims) {
  if (claims.userId != null && typeof db.getUserById === 'function') {
    const user = await db.getUserById(claims.userId);
    if (user) return user;
  }
  return claims.username && typeof db.getUser === 'function' ? db.getUser(claims.username) : null;
}

function purchaseBelongsTo(purchase, user) {
  const purchaseUserId = purchase?.account_user_id ?? purchase?.user_id;
  if (purchaseUserId != null && user?.id != null && String(purchaseUserId) === String(user.id)) return true;
  return Boolean(purchase?.username && user?.username && purchase.username === user.username);
}

export async function deterministicAppAccountToken(user) {
  const stable = String(user?.id ?? user?.username ?? '');
  if (!stable) throw new Error('user has no stable identity');
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`com.ombhrum.fabushi:app-account:${stable}`),
  ));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rawDatabase(env, db) {
  return db?.db || env.DB || null;
}

async function ensureLedger(database) {
  await database.prepare(`
    CREATE TABLE IF NOT EXISTS apple_iap_receipts (
      transaction_id TEXT PRIMARY KEY,
      original_transaction_id TEXT,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      product_id TEXT NOT NULL,
      app_account_token TEXT NOT NULL,
      purchased_at TEXT NOT NULL,
      fulfilled_at TEXT NOT NULL
    )
  `).run();
}

function validToFor(transaction, product) {
  if (product.productType === 'asset_unlock') return PERMANENT_VALID_TO;
  const timestamp = Number(transaction.expiresDate);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('Apple subscription has no valid expiresDate');
  const expiry = new Date(timestamp);
  if (Number.isNaN(expiry.getTime())) throw new Error('Apple subscription expiry is invalid');
  return expiry.toISOString();
}

async function findPurchase(db, transactionId) {
  return typeof db.prepare === 'function'
    ? db.prepare('SELECT * FROM purchase_history WHERE order_id = ?').bind(transactionId).first()
    : null;
}

async function restoreExisting(db, user, purchase, product) {
  const validTo = purchase?.valid_to || purchase?.validTo || user?.membership_expires_at || null;
  if (product.productType === 'membership' && validTo) {
    const candidate = new Date(validTo);
    const current = user.membership_expires_at ? new Date(user.membership_expires_at) : null;
    if (!Number.isNaN(candidate.getTime()) && (!current || Number.isNaN(current.getTime()) || candidate > current)) {
      await db.updateUser(user.username, { membership_type: 'paid', membership_expires_at: candidate.toISOString() });
    }
  }
  return jsonResponse({
    success: true,
    message: '交易已处理',
    alreadyProcessed: true,
    productType: product.productType,
    membershipType: product.productType === 'membership' ? 'paid' : user.membership_type,
    expiresAt: validTo,
    unlocked: product.productType === 'asset_unlock',
  });
}

export async function handleVerifyAppleReceipt(request, env, db, options = {}) {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return jsonResponse({ error: '未提供认证信息' }, 401);
  const claims = await verifyToken(authorization.slice(7), env);
  if (!claims) return jsonResponse({ error: '认证失败' }, 401);
  const user = await userForClaims(db, claims);
  if (!user) return jsonResponse({ error: '用户不存在' }, 404);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式无效' }, 400); }
  const transactionId = String(body?.transactionId || '').trim();
  const productId = String(body?.productId || '').trim();
  const product = APPLE_IAP_PRODUCTS[productId];
  if (!/^[A-Za-z0-9._-]{6,128}$/.test(transactionId) || !product) {
    return jsonResponse({ error: '交易或商品参数无效' }, 400);
  }

  const previous = await findPurchase(db, transactionId);
  if (previous) {
    if (!purchaseBelongsTo(previous, user)) return jsonResponse({ error: '该交易已属于其他账号' }, 409);
    return restoreExisting(db, user, previous, product);
  }

  const c = config(env);
  if (!c.issuerId || !c.keyId || !c.privateKey || !c.bundleId) return jsonResponse({ error: '服务器 IAP 验证暂未配置' }, 503);

  try {
    const transaction = await fetchTransaction(transactionId, env, options);
    if (String(transaction.transactionId || '') !== transactionId) return jsonResponse({ error: 'Apple 交易号不匹配' }, 403);
    if (transaction.bundleId !== c.bundleId) return jsonResponse({ error: 'Bundle ID 不匹配' }, 403);
    if (transaction.productId !== productId) return jsonResponse({ error: '商品 ID 不匹配' }, 403);
    if (transaction.revocationDate) return jsonResponse({ error: '该交易已被撤销或退款' }, 403);

    const expectedAccountToken = await deterministicAppAccountToken(user);
    if (!transaction.appAccountToken || String(transaction.appAccountToken).toLowerCase() !== expectedAccountToken) {
      return jsonResponse({
        error: 'Apple 交易未绑定到当前 Fabushi 账号',
        code: 'APP_ACCOUNT_TOKEN_MISMATCH',
        appAccountToken: expectedAccountToken,
      }, 409);
    }

    const database = rawDatabase(env, db);
    if (!database?.prepare || !database?.batch) throw new Error('atomic Apple IAP database unavailable');
    await ensureLedger(database);
    const ledger = await database.prepare('SELECT user_id, username FROM apple_iap_receipts WHERE transaction_id = ?').bind(transactionId).first();
    if (ledger) {
      if (String(ledger.user_id) !== String(user.id) && ledger.username !== user.username) return jsonResponse({ error: '该交易已属于其他账号' }, 409);
      return jsonResponse({ success: true, alreadyProcessed: true, productType: product.productType });
    }

    const purchasedAt = Number(transaction.purchaseDate) > 0 ? new Date(Number(transaction.purchaseDate)) : new Date();
    if (Number.isNaN(purchasedAt.getTime())) throw new Error('Apple purchaseDate is invalid');
    const validTo = validToFor(transaction, product);
    const now = new Date().toISOString();
    const statements = [
      database.prepare(`INSERT INTO apple_iap_receipts (
        transaction_id, original_transaction_id, user_id, username, product_id, app_account_token, purchased_at, fulfilled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        transactionId, transaction.originalTransactionId || null, Number(user.id), user.username,
        productId, expectedAccountToken, purchasedAt.toISOString(), now,
      ),
      database.prepare(`INSERT INTO purchase_history (
        username, user_id, order_id, plan, amount, currency, status, payment_method, purchased_at, valid_from, valid_to
      ) VALUES (?, ?, ?, ?, ?, 'CNY', 'completed', 'apple_iap', ?, ?, ?)`).bind(
        user.username, Number(user.id), transactionId, product.plan, product.price,
        purchasedAt.toISOString(), purchasedAt.toISOString(), validTo,
      ),
    ];
    if (product.productType === 'membership') {
      statements.push(database.prepare(
        `UPDATE users SET membership_type = 'paid', membership_expires_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(validTo, now, Number(user.id)));
    }

    try {
      await database.batch(statements);
    } catch (error) {
      const winner = await database.prepare('SELECT user_id, username FROM apple_iap_receipts WHERE transaction_id = ?').bind(transactionId).first();
      if (!winner) throw error;
      if (String(winner.user_id) !== String(user.id) && winner.username !== user.username) return jsonResponse({ error: '该交易已属于其他账号' }, 409);
      return jsonResponse({ success: true, alreadyProcessed: true, productType: product.productType, expiresAt: validTo });
    }

    return jsonResponse({
      success: true,
      message: product.productType === 'asset_unlock' ? '素材已解锁' : 'Apple IAP 验证成功',
      productType: product.productType,
      membershipType: product.productType === 'membership' ? 'paid' : user.membership_type,
      expiresAt: validTo,
      unlocked: product.productType === 'asset_unlock',
    });
  } catch (error) {
    console.error('Apple IAP verification failed:', error?.message || error);
    return jsonResponse({ error: 'Apple IAP 验证失败' }, 502);
  }
}
