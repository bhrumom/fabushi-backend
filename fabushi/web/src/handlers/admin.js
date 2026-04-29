import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { isAdmin } from '../utils/helpers.js';

// 检查管理员状态
export async function handleCheckAdminStatus(request, env, db) {
  console.log('🔍 handleCheckAdminStatus 被调用');
  const authHeader = request.headers.get('Authorization');
  console.log('📋 Authorization header:', authHeader ? authHeader.substring(0, 30) + '...' : 'null');

  if (!authHeader?.startsWith('Bearer ')) {
    console.log('❌ 未提供认证信息');
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  console.log('🔑 Token preview:', token.substring(0, 30) + '...');
  console.log('🔐 JWT_SECRET 状态:', env.JWT_SECRET ? '已配置' : '未配置（将使用默认值）');

  const tokenData = await verifyToken(token, env);
  console.log('✅ Token 验证结果:', tokenData ? '成功' : '失败');

  if (!tokenData) {
    console.log('❌ Token 验证失败，返回 401');
    return jsonResponse({ error: '认证失败' }, 401);
  }

  const user = await db.getUser(tokenData.username);
  if (!user) return jsonResponse({ error: '用户不存在' }, 404);

  return jsonResponse({
    isAdmin: isAdmin(user.email),
    email: user.email,
    username: user.username,
    nickname: user.username,
    avatar: user.avatar || user.alipay_avatar || user.wechat_headimgurl || null,
    phoneNumber: user.phone_number || null,
    firebaseUid: user.firebase_uid || null,
    hasPassword: Boolean(user.password_hash && user.salt),
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

// 查询兑换码列表
export async function handleListRedeemCodes(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) return jsonResponse({ error: '认证失败' }, 401);

  const user = await db.getUser(tokenData.username);
  if (!isAdmin(user.email)) {
    return jsonResponse({ error: '权限不足' }, 403);
  }

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = parseInt(url.searchParams.get('limit') || '20');
  const status = url.searchParams.get('status');

  const codes = await db.listRedeemCodes(status, page, limit);
  return jsonResponse(codes);
}

// 删除兑换码
export async function handleDeleteRedeemCode(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) return jsonResponse({ error: '认证失败' }, 401);

  const user = await db.getUser(tokenData.username);
  if (!isAdmin(user.email)) {
    return jsonResponse({ error: '权限不足' }, 403);
  }

  const { code } = await request.json();
  if (!code) return jsonResponse({ error: '兑换码不能为空' }, 400);

  await db.deleteRedeemCode(code.toUpperCase());
  return jsonResponse({ message: '兑换码删除成功' });
}

// 获取管理员价格
export async function handleGetAdminPrice(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) return jsonResponse({ error: '认证失败' }, 401);

  const user = await db.getUser(tokenData.username);
  const { plan } = await request.json();
  const { MEMBERSHIP_PLANS } = await import('../config/constants.js');

  if (isAdmin(user.email)) {
    return jsonResponse({
      isAdmin: true,
      originalPrice: MEMBERSHIP_PLANS[plan].price,
      adminPrice: MEMBERSHIP_PLANS[plan].adminPrice,
      plan
    });
  }

  return jsonResponse({
    isAdmin: false,
    price: MEMBERSHIP_PLANS[plan].price,
    plan
  });
}
