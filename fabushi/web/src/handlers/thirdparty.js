import { jsonResponse } from '../utils/response.js';
import { verifyToken, generateToken } from '../../auth-utils.js';

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
  return await handleAlipayLogin(request, env);
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
  return await registerAlipayUser(request, env);
}

// 绑定邮箱
export async function handleBindEmail(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) return jsonResponse({ error: '认证失败' }, 401);

  const { email, verificationCode } = await request.json();
  if (!email || !verificationCode) {
    return jsonResponse({ error: '邮箱与验证码不能为空' }, 400);
  }

  const normalizedEmail = email.toLowerCase();
  const verifyData = await env.USERS_KV.get(`verify:${normalizedEmail}`);
  if (!verifyData) return jsonResponse({ error: '验证码不存在或已过期' }, 400);

  const { code, expiry } = JSON.parse(verifyData);
  if (Date.now() > expiry || verificationCode !== code) {
    return jsonResponse({ error: '验证码错误或已过期' }, 400);
  }

  const existing = await db.getUserByEmail(normalizedEmail);
  if (existing) return jsonResponse({ error: '该邮箱已被其他账号绑定' }, 400);

  await db.updateUser(tokenData.username, { email: normalizedEmail, email_verified: 1 });
  await env.USERS_KV.delete(`verify:${normalizedEmail}`);

  return jsonResponse({ message: '邮箱绑定成功', email: normalizedEmail });
}

// 获取支付宝SDK授权字符串
export async function handleGetAlipayAuthString(request, env) {
  const { handleGetAlipayAuthString } = await import('../../alipay-login-functions.js');
  return await handleGetAlipayAuthString(request, env);
}

// 支付宝SDK登录
export async function handleAlipaySDKLogin(request, env) {
  const { handleAlipaySDKLogin } = await import('../../alipay-login-functions.js');
  return await handleAlipaySDKLogin(request, env);
}
