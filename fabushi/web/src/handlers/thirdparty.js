import { jsonResponse } from '../utils/response.js';
import { AccountUserRepository } from '../repositories/account-user-repository.js';
import { asApiError } from '../contracts/api-error.js';
import { bindEmailFromRequest } from '../use-cases/bind-email.js';

function serializeAlipayAccountUser(user) {
  if (!user) return null;

  const userNo = user.user_no ?? user.id ?? null;
  return {
    id: user.id,
    userId: user.id,
    userNo,
    username: user.username,
    email: user.email || '',
    nickname: user.nickname || user.alipay_nickname || user.username,
    avatar: user.avatar || user.alipay_avatar || user.wechat_headimgurl || null,
    phoneNumber: user.phone_number || null,
    firebaseUid: user.firebase_uid || null,
    alipayUserId: user.alipay_user_id || null,
    alipayNickname: user.alipay_nickname || null,
    alipayAvatar: user.alipay_avatar || null,
    createdAt: user.created_at || null,
    emailVerified: user.email_verified === 1 || user.email_verified === true,
    membership: {
      type: user.membership_type || 'expired',
      expiresAt: user.membership_expires_at || user.free_trial_end_date || null,
    },
  };
}

async function readUserForAuthResponse(env, payload) {
  if (!env.DB || !payload) return null;

  if (payload.userId !== undefined && payload.userId !== null) {
    const byId = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.userId).first();
    if (byId) return byId;
  }

  if (payload.username) {
    return await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(payload.username).first();
  }

  return null;
}

async function withFullUserResponse(response, env) {
  if (!response || ![200, 201].includes(response.status)) {
    return response;
  }

  let payload;
  try {
    payload = await response.clone().json();
  } catch (_) {
    return response;
  }

  if (!payload || payload.user) {
    return response;
  }

  const user = await readUserForAuthResponse(env, payload);
  if (!user) {
    return response;
  }

  return jsonResponse({
    ...payload,
    user: serializeAlipayAccountUser(user),
  }, response.status);
}

// 微信登录URL
export async function handleGetWechatLoginUrl(request, env) {
  const state = crypto.randomUUID();
  const appId = env.WECHAT_APP_ID;
  const redirectUri = encodeURIComponent(env.WECHAT_REDIRECT_URI);
  const authUrl = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${appId}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_userinfo&state=${state}#wechat_redirect`;

  await env.USERS_KV.put(`wechat_state:${state}`, 'valid', { expirationTtl: 600 });
  return jsonResponse({ authUrl, state });
}

// 支付宝登录URL
export async function handleGetAlipayLoginUrl(request, env) {
  const { generateAlipayLoginUrl } = await import('../../alipay-login-functions.js');
  const platform = new URL(request.url).searchParams.get('platform');
  return await generateAlipayLoginUrl(env, platform);
}

// 支付宝登录
export async function handleAlipayLogin(request, env) {
  const { handleAlipayLogin } = await import('../../alipay-login-functions.js');
  const response = await handleAlipayLogin(request, env);
  return await withFullUserResponse(response, env);
}

// macOS支付宝回调
export async function handleMacOSAlipayCallback(request, env) {
  const { handleMacOSAlipayCallback } = await import('../../alipay-login-functions.js');
  return await handleMacOSAlipayCallback(request, env);
}

// 移动端（iOS/Android）支付宝回调
export async function handleMobileAlipayCallback(request, env) {
  const { handleMobileAlipayCallback } = await import('../../alipay-login-functions.js');
  return await handleMobileAlipayCallback(request, env);
}

// 支付宝注册
export async function handleAlipayRegister(request, env) {
  const { registerAlipayUser } = await import('../../alipay-login-functions.js');
  const response = await registerAlipayUser(request, env);
  return await withFullUserResponse(response, env);
}

// 绑定邮箱
export async function handleBindEmail(request, env, db) {
  const repository = new AccountUserRepository(db);

  try {
    const payload = await bindEmailFromRequest(request, env, repository);
    return jsonResponse(payload);
  } catch (error) {
    const apiError = asApiError(error, '邮箱绑定失败');
    return jsonResponse({ error: apiError.message }, apiError.status);
  }
}

// 获取支付宝SDK授权字符串
export async function handleGetAlipayAuthString(request, env) {
  const { handleGetAlipayAuthString } = await import('../../alipay-login-functions.js');
  return await handleGetAlipayAuthString(request, env);
}

// 支付宝SDK登录
export async function handleAlipaySDKLogin(request, env) {
  const { handleAlipaySDKLogin } = await import('../../alipay-login-functions.js');
  const response = await handleAlipaySDKLogin(request, env);
  return await withFullUserResponse(response, env);
}
