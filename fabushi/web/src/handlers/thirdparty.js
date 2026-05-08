import { jsonResponse } from '../utils/response.js';
import { AccountUserRepository } from '../repositories/account-user-repository.js';
import { asApiError } from '../contracts/api-error.js';
import { bindEmailFromRequest } from '../use-cases/bind-email.js';

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
  return await handleAlipaySDKLogin(request, env);
}
