import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { REDEEM_CODE_TYPES } from '../config/constants.js';
import { isAdminUser, generateRedeemCode } from '../utils/helpers.js';

async function authenticatedUser(request, env, db) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const tokenData = await verifyToken(authHeader.slice(7), env);
  if (!tokenData) return null;
  if (tokenData.userId !== undefined && tokenData.userId !== null && db.getUserById) {
    const user = await db.getUserById(tokenData.userId);
    if (user) return { user, tokenData };
  }
  if (tokenData.username) {
    const user = await db.getUser(tokenData.username);
    if (user) return { user, tokenData };
  }
  return null;
}

async function ensureRedeemClaims(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS redeem_claims (
      code TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      claimed_at TEXT NOT NULL
    )
  `).run();
}

export async function handleCreateRedeemCode(request, env, db) {
  const auth = await authenticatedUser(request, env, db);
  if (!auth) return jsonResponse({ error: '认证失败' }, 401);
  if (!isAdminUser(auth.user, env)) return jsonResponse({ error: '权限不足' }, 403);

  const { type, quantity = 1, description = '' } = await request.json();
  const codeType = REDEEM_CODE_TYPES[type];
  const normalizedQuantity = Number(quantity);
  if (!codeType) return jsonResponse({ error: '无效的兑换码类型' }, 400);
  if (!Number.isInteger(normalizedQuantity) || normalizedQuantity < 1 || normalizedQuantity > 100) {
    return jsonResponse({ error: '单次生成数量必须在 1 到 100 之间' }, 400);
  }
  if (String(description).length > 500) return jsonResponse({ error: '描述过长' }, 400);

  const codes = [];
  for (let i = 0; i < normalizedQuantity; i += 1) {
    let created = false;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const code = generateRedeemCode();
      try {
        await db.createRedeemCode({
          code,
          type: codeType.type,
          days: codeType.days,
          name: codeType.name,
          description: String(description),
          createdBy: auth.user.username,
          createdAt: new Date().toISOString()
        });
        codes.push(code);
        created = true;
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
  }

  return jsonResponse({ success: true, message: `成功生成${codes.length}个兑换码`, codes, type: codeType.name });
}

export async function handleUseRedeemCode(request, env, db) {
  const auth = await authenticatedUser(request, env, db);
  if (!auth) return jsonResponse({ error: '认证失败' }, 401);

  const body = await request.json();
  const code = String(body?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8,64}$/.test(code)) return jsonResponse({ error: '兑换码无效' }, 400);

  const redeemCode = await db.getRedeemCode(code);
  if (!redeemCode || Number(redeemCode.used) === 1) return jsonResponse({ error: '兑换码不存在或已使用' }, 400);
  const days = Number(redeemCode.days);
  if (!Number.isInteger(days) || days <= 0 || days > 3660) return jsonResponse({ error: '兑换码配置无效' }, 400);

  await ensureRedeemClaims(env);
  const now = new Date();
  const previousExpiry = auth.user.membership_expires_at && new Date(auth.user.membership_expires_at) > now
    ? new Date(auth.user.membership_expires_at)
    : null;
  const start = previousExpiry || now;
  const expiry = new Date(start.getTime());
  expiry.setUTCDate(expiry.getUTCDate() + days);
  const userId = Number(auth.user.id);
  if (!Number.isFinite(userId)) return jsonResponse({ error: '用户身份无效' }, 400);

  const statements = [
    env.DB.prepare('INSERT INTO redeem_claims (code, user_id, username, claimed_at) VALUES (?, ?, ?, ?)')
      .bind(code, userId, auth.user.username, now.toISOString()),
    env.DB.prepare('UPDATE redeem_codes SET used = 1, used_by = ?, used_at = ? WHERE code = ? AND used = 0')
      .bind(auth.user.username, now.toISOString(), code),
    env.DB.prepare('UPDATE users SET membership_type = ?, membership_expires_at = ?, updated_at = ? WHERE id = ?')
      .bind(redeemCode.type, expiry.toISOString(), now.toISOString(), userId),
    env.DB.prepare(`
      INSERT INTO redeem_history (
        username, user_id, code, type, days, redeemed_at, valid_from, valid_to, previous_expiry_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      auth.user.username,
      userId,
      code,
      redeemCode.type,
      days,
      now.toISOString(),
      now.toISOString(),
      expiry.toISOString(),
      previousExpiry?.toISOString() || null
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const existing = await env.DB.prepare('SELECT user_id FROM redeem_claims WHERE code = ?').bind(code).first();
    if (existing) return jsonResponse({ error: '兑换码不存在或已使用' }, 409);
    console.error('兑换码原子兑换失败:', error?.message || error);
    return jsonResponse({ error: '兑换失败，请稍后重试' }, 500);
  }

  const updated = await env.DB.prepare('SELECT used FROM redeem_codes WHERE code = ?').bind(code).first();
  if (Number(updated?.used) !== 1) {
    console.error('Redeem invariant failed for code claim');
    return jsonResponse({ error: '兑换状态异常，请联系客服' }, 500);
  }

  return jsonResponse({
    success: true,
    message: `兑换成功！获得${redeemCode.name}`,
    expiresAt: expiry.toISOString(),
    daysAdded: days
  });
}

export async function handleGetPurchaseHistory(request, env, db) {
  const auth = await authenticatedUser(request, env, db);
  if (!auth) return jsonResponse({ error: '认证失败' }, 401);
  const purchases = await db.getPurchaseHistory(auth.user.username, auth.user.id);
  return jsonResponse({ success: true, purchases, total: purchases.length });
}

export async function handleGetRedeemHistory(request, env, db) {
  const auth = await authenticatedUser(request, env, db);
  if (!auth) return jsonResponse({ error: '认证失败' }, 401);
  const redeems = await db.getRedeemHistory(auth.user.username, auth.user.id);
  return jsonResponse({ success: true, redeems, total: redeems.length });
}
