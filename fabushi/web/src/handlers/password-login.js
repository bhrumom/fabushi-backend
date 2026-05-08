import { jsonResponse } from '../utils/response.js';
import { verifyPassword, generateToken } from '../../auth-utils.js';

function looksLikeEmail(value) {
  return String(value || '').includes('@');
}

function looksLikePhone(value) {
  return /^\+?[0-9]{6,20}$/.test(String(value || '').trim());
}

export async function handlePasswordLogin(request, env, db) {
  const { username: loginIdentifier, password } = await request.json();
  const identifier = String(loginIdentifier || '').trim();
  if (!identifier || !password) {
    return jsonResponse({ error: '手机号、用户名或邮箱和密码不能为空' }, 400);
  }

  let user;
  if (looksLikeEmail(identifier)) {
    user = await db.getUserByEmail(identifier.toLowerCase());
  } else if (looksLikePhone(identifier)) {
    user = await db.getUserByPhone(identifier);
  }
  if (!user) user = await db.getUser(identifier);
  if (!user) return jsonResponse({ error: '用户不存在' }, 401);
  if (!user.password_hash || !user.salt) {
    return jsonResponse({ error: '当前账号尚未设置密码，请先通过已登录资料页设置密码' }, 401);
  }

  const ok = await verifyPassword(password, {
    passwordHash: user.password_hash,
    salt: user.salt,
    iterations: user.iterations,
    algo: user.algo
  });
  if (!ok) return jsonResponse({ error: '密码错误' }, 401);

  const token = await generateToken({ id: user.id, username: user.username }, env);
  return jsonResponse({
    token,
    username: user.username,
    userId: user.id,
    user: {
      id: user.id,
      userId: user.id,
      username: user.username,
      email: user.email || '',
      nickname: user.nickname || user.username,
      avatar: user.avatar || user.alipay_avatar || user.wechat_headimgurl || null,
      phoneNumber: user.phone_number || null,
      hasPassword: true,
      emailVerified: user.email_verified === 1,
      createdAt: user.created_at,
      membership: {
        type: user.membership_type || 'expired',
        expiresAt: user.membership_expires_at || user.free_trial_end_date || null
      }
    }
  });
}
