import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { hasUnlimitedUsage, isAdminUser } from '../utils/helpers.js';
import { MEMBERSHIP_PLANS } from '../config/constants.js';

async function resolveAdminActor(request, env, db, requireAdmin = true) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return { response: jsonResponse({ error: '未提供认证信息' }, 401) };
  const tokenData = await verifyToken(authHeader.slice(7), env);
  if (!tokenData) return { response: jsonResponse({ error: '认证失败' }, 401) };

  let user = null;
  if (tokenData.userId !== undefined && tokenData.userId !== null && db.getUserById) {
    user = await db.getUserById(tokenData.userId);
  }
  if (!user && tokenData.username) user = await db.getUser(tokenData.username);
  if (!user) return { response: jsonResponse({ error: '用户不存在' }, 404) };
  const admin = isAdminUser(user, env);
  if (requireAdmin && !admin) return { response: jsonResponse({ error: '权限不足' }, 403) };
  return { user, tokenData, admin };
}

function adminTestPricingEnabled(env) {
  return env?.ENVIRONMENT === 'development' && env?.ALLOW_ADMIN_TEST_PRICING === 'true';
}

export async function handleCheckAdminStatus(request, env, db) {
  const actor = await resolveAdminActor(request, env, db, false);
  if (actor.response) return actor.response;
  const { user, admin } = actor;
  const unlimitedUsage = hasUnlimitedUsage(user, env);
  return jsonResponse({
    isAdmin: admin,
    role: unlimitedUsage ? 'super_admin' : admin ? 'admin' : 'user',
    unlimitedUsage,
    email: user.email,
    username: user.username,
    nickname: user.nickname || user.username,
    avatar: user.avatar || user.alipay_avatar || user.wechat_headimgurl || null,
    phoneNumber: user.phone_number || null,
    firebaseUid: user.firebase_uid || null,
    hasPassword: Boolean(user.password_hash && user.salt),
    alipayProviderSubject: user.alipay_user_id || null,
    alipayUserId: user.alipay_user_id || null,
    alipayNickname: user.alipay_nickname || null,
    alipayAvatar: user.alipay_avatar || null,
    mainPractice: user.main_practice_title ? {
      title: user.main_practice_title,
      filePath: user.main_practice_file_path,
      selectedAt: user.main_practice_selected_at
    } : null,
    membershipType: user.membership_type || 'expired',
    membershipExpiresAt: user.membership_expires_at || user.free_trial_end_date || null
  });
}

export async function handleListRedeemCodes(request, env, db) {
  const actor = await resolveAdminActor(request, env, db);
  if (actor.response) return actor.response;
  const url = new URL(request.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20));
  const status = url.searchParams.get('status');
  const codes = await db.listRedeemCodes(status, page, limit);
  return jsonResponse(codes);
}

export async function handleDeleteRedeemCode(request, env, db) {
  const actor = await resolveAdminActor(request, env, db);
  if (actor.response) return actor.response;
  const { code } = await request.json();
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8,64}$/.test(normalized)) return jsonResponse({ error: '兑换码无效' }, 400);
  await db.deleteRedeemCode(normalized);
  return jsonResponse({ message: '兑换码删除成功' });
}

export async function handleGetAdminPrice(request, env, db) {
  const actor = await resolveAdminActor(request, env, db, false);
  if (actor.response) return actor.response;
  const { plan } = await request.json();
  const planInfo = MEMBERSHIP_PLANS[plan];
  if (!planInfo) return jsonResponse({ error: '无效的会员方案' }, 400);

  if (actor.admin && adminTestPricingEnabled(env)) {
    return jsonResponse({ isAdmin: true, originalPrice: planInfo.price, adminPrice: planInfo.adminPrice, plan, testPricing: true });
  }
  return jsonResponse({ isAdmin: actor.admin, price: planInfo.price, plan, testPricing: false });
}
