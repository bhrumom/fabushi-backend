import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';

// 检查会员状态 - Stripe端点
export async function handleCheckMembershipStatus(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return jsonResponse({ error: '认证失败' }, 401);
  }

  const user = await db.getUser(tokenData.username);
  if (!user) {
    return jsonResponse({ error: '用户不存在' }, 404);
  }

  // 计算会员状态
  const now = new Date();
  const membershipExpiry = user.membership_expires_at ? new Date(user.membership_expires_at) : null;
  const isActive = membershipExpiry && membershipExpiry > now;
  const daysLeft = isActive ? Math.ceil((membershipExpiry - now) / (1000 * 60 * 60 * 24)) : 0;

  return jsonResponse({
    username: user.username,
    email: user.email,
    membership: {
      isActive,
      type: user.membership_type || 'free',
      expiresAt: user.membership_expires_at,
      daysLeft
    },
    hasStripeCustomer: false // 暂时设为false，因为使用支付宝
  });
}

// 检查会员状态 - 支付宝端点
export async function handleCheckAlipayMembership(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return jsonResponse({ error: '认证失败' }, 401);
  }

  const user = await db.getUser(tokenData.username);
  if (!user) {
    return jsonResponse({ error: '用户不存在' }, 404);
  }

  // 计算会员状态
  const now = new Date();
  const membershipExpiry = user.membership_expires_at ? new Date(user.membership_expires_at) : null;
  const isActive = membershipExpiry && membershipExpiry > now;
  const daysLeft = isActive ? Math.ceil((membershipExpiry - now) / (1000 * 60 * 60 * 24)) : 0;

  return jsonResponse({
    username: user.username,
    email: user.email,
    membership: {
      isActive,
      type: user.membership_type || 'free',
      expiresAt: user.membership_expires_at,
      daysLeft
    },
    hasStripeCustomer: false
  });
}