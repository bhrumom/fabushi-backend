import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { isTestAccountRequest, testAccountUser } from '../utils/test-account.js';

async function resolveTokenUser(db, tokenData) {
  if (tokenData?.userId !== undefined && tokenData?.userId !== null && db.getUserById) {
    const user = await db.getUserById(tokenData.userId);
    if (user) return user;
  }
  if (tokenData?.username) {
    return await db.getUser(tokenData.username);
  }
  return null;
}

async function requireMembershipUser(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { response: jsonResponse({ error: '未提供认证信息' }, 401) };
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return { response: jsonResponse({ error: '认证失败' }, 401) };
  }

  const user = await resolveTokenUser(db, tokenData);
  if (!user) {
    return { response: jsonResponse({ error: '用户不存在' }, 404) };
  }

  return { user, tokenData };
}

function buildMembershipPayload(user) {
  const now = new Date();
  const membershipExpiry = user.membership_expires_at
    ? new Date(user.membership_expires_at)
    : user.free_trial_end_date
      ? new Date(user.free_trial_end_date)
      : null;
  const isActive = membershipExpiry && membershipExpiry > now;
  const daysLeft = isActive ? Math.ceil((membershipExpiry - now) / (1000 * 60 * 60 * 24)) : 0;

  return {
    username: user.username,
    userId: user.id,
    userNo: user.user_no ?? user.id ?? null,
    email: user.email,
    membership: {
      isActive,
      type: user.membership_type || 'free',
      expiresAt: user.membership_expires_at || user.free_trial_end_date || null,
      daysLeft
    },
    hasStripeCustomer: false
  };
}

async function testAccountMembershipResponse(request, env) {
  if (!await isTestAccountRequest(request, env)) return null;
  const user = testAccountUser();
  return jsonResponse({
    username: user.username,
    userId: user.userId,
    userNo: user.userNo,
    email: user.email,
    isTestAccount: true,
    membership: {
      isActive: true,
      active: true,
      type: 'lifetime',
      expiresAt: null,
      daysLeft: null,
    },
    hasStripeCustomer: false,
  });
}

// 检查会员状态 - Stripe端点
export async function handleCheckMembershipStatus(request, env, db) {
  const testAccount = await testAccountMembershipResponse(request, env);
  if (testAccount) return testAccount;
  const result = await requireMembershipUser(request, env, db);
  if (result.response) return result.response;
  return jsonResponse(buildMembershipPayload(result.user));
}

// 检查会员状态 - 支付宝端点
export async function handleCheckAlipayMembership(request, env, db) {
  const testAccount = await testAccountMembershipResponse(request, env);
  if (testAccount) return testAccount;
  const result = await requireMembershipUser(request, env, db);
  if (result.response) return result.response;
  return jsonResponse(buildMembershipPayload(result.user));
}
