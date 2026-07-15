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
    alipayProviderSubject: user.alipay_user_id || null,
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

// 微信小程序登录
export async function handleWechatMPLogin(request, env, db) {
  try {
    const { code } = await request.json();
    if (!code) {
      return jsonResponse({ error: '缺少 code 参数' }, 400);
    }

    const appId = env.WECHAT_MP_APP_ID || env.WECHAT_APP_ID;
    const secret = env.WECHAT_MP_APP_SECRET || env.WECHAT_APP_SECRET;

    if (!appId || !secret) {
      return jsonResponse({ error: '未配置微信小程序 AppID 或 Secret' }, 500);
    }

    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${secret}&js_code=${code}&grant_type=authorization_code`;
    const wechatRes = await fetch(url);
    const wechatData = await wechatRes.json();

    if (wechatData.errcode) {
      console.error('WeChat login failed:', wechatData);
      return jsonResponse({ error: '微信登录验证失败: ' + wechatData.errmsg }, 400);
    }

    const openid = wechatData.openid;
    let user = await db.getUserByWechatOpenid(openid);
    const { generateToken } = await import('../../auth-utils.js');
    const { calculateTrialEndDate } = await import('../../stripe-config.js');

    let isNewUser = false;
    if (!user) {
      const username = `wechat_${Date.now().toString(36)}`;
      const trialEndDate = calculateTrialEndDate();
      
      user = await db.createWechatUser({
        username,
        openid,
        nickname: '微信用户',
        membershipType: 'trial',
        membershipExpiresAt: trialEndDate.toISOString(),
        createdAt: new Date().toISOString()
      });
      isNewUser = true;
    }

    // Reuse serializeAlipayAccountUser as a general serializer, or do it manually
    const userPayload = {
      id: user.id,
      userId: user.id,
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar || user.wechat_headimgurl || null,
      membership: {
        type: user.membership_type || 'expired',
        expiresAt: user.membership_expires_at || user.free_trial_end_date || null,
      }
    };

    return jsonResponse({
      success: true,
      token: await generateToken({ id: user.id, username: user.username }, env),
      username: user.username,
      userId: user.id,
      isNewUser,
      user: userPayload
    });

  } catch (error) {
    console.error('WeChat MP Login Error:', error);
    return jsonResponse({ error: '微信小程序登录失败: ' + error.message }, 500);
  }
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

// 支付宝 OAuth 回调（Web/移动端网页登录共用入口）
export async function handleAlipayCallback(request, env) {
  const { handleAlipayCallback } = await import('../../alipay-login-functions.js');
  return await handleAlipayCallback(request, env);
}

export async function handleAlipayCliSession(request, env) {
  const { handleAlipayCliSession } = await import('../../alipay-login-functions.js');
  return await handleAlipayCliSession(request, env);
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
