import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { REDEEM_CODE_TYPES } from '../config/constants.js';
import { isAdmin, generateRedeemCode } from '../utils/helpers.js';

// 生成兑换码
export async function handleCreateRedeemCode(request, env, db) {
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
  if (!isAdmin(user.email)) {
    return jsonResponse({ error: '权限不足' }, 403);
  }

  const { type, quantity = 1, description = '' } = await request.json();
  const codeType = REDEEM_CODE_TYPES[type];
  
  if (!codeType) {
    return jsonResponse({ error: '无效的兑换码类型' }, 400);
  }

  const codes = [];
  for (let i = 0; i < quantity; i++) {
    const code = generateRedeemCode();
    await db.createRedeemCode({
      code,
      type: codeType.type,
      days: codeType.days,
      name: codeType.name,
      description,
      createdBy: tokenData.username,
      createdAt: new Date().toISOString()
    });
    codes.push(code);
  }

  return jsonResponse({
    message: `成功生成${quantity}个兑换码`,
    codes,
    type: codeType.name
  });
}

// 使用兑换码
export async function handleUseRedeemCode(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return jsonResponse({ error: '认证失败' }, 401);
  }

  const { code } = await request.json();
  if (!code) {
    return jsonResponse({ error: '兑换码不能为空' }, 400);
  }

  const redeemCode = await db.getRedeemCode(code.toUpperCase());
  if (!redeemCode) {
    return jsonResponse({ error: '兑换码不存在或已使用' }, 400);
  }

  const user = await db.getUser(tokenData.username);
  const now = new Date();
  let newExpiryDate = new Date(now);
  
  if (user.membership_expires_at && new Date(user.membership_expires_at) > now) {
    newExpiryDate = new Date(user.membership_expires_at);
  }
  
  newExpiryDate.setDate(newExpiryDate.getDate() + redeemCode.days);

  await db.updateUser(tokenData.username, {
    membership_type: redeemCode.type,
    membership_expires_at: newExpiryDate.toISOString()
  });

  await db.useRedeemCode(code.toUpperCase(), tokenData.username);

  await db.addRedeemHistory({
    username: tokenData.username,
    code: code.toUpperCase(),
    type: redeemCode.type,
    days: redeemCode.days,
    redeemedAt: now.toISOString(),
    validFrom: now.toISOString(),
    validTo: newExpiryDate.toISOString()
  });

  return jsonResponse({
    message: `兑换成功！获得${redeemCode.name}`,
    expiresAt: newExpiryDate.toISOString(),
    daysAdded: redeemCode.days
  });
}

// 获取购买记录
export async function handleGetPurchaseHistory(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return jsonResponse({ error: '认证失败' }, 401);
  }

  const purchases = await db.getPurchaseHistory(tokenData.username);
  return jsonResponse({
    purchases,
    total: purchases.length
  });
}

// 获取兑换记录
export async function handleGetRedeemHistory(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return jsonResponse({ error: '认证失败' }, 401);
  }

  const redeems = await db.getRedeemHistory(tokenData.username);
  return jsonResponse({
    redeems,
    total: redeems.length
  });
}
