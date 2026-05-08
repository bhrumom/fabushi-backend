import {
  handleRegister,
  handleLogin,
  handleGetUserInfo,
  handleUpdateProfile,
  handleFirebasePhoneLogin,
  handleAppleLogin,
  handleDeleteAccount,
} from '../handlers/auth.js';
import {
  handleGetWechatLoginUrl,
  handleGetAlipayLoginUrl,
  handleAlipayLogin,
  handleAlipayRegister,
  handleBindEmail,
  handleMacOSAlipayCallback,
  handleMobileAlipayCallback,
  handleGetAlipayAuthString,
  handleAlipaySDKLogin,
} from '../handlers/thirdparty.js';
import {
  handleSendVerificationCode,
  handleForgotPassword,
  handleResetPassword,
} from '../handlers/verification.js';

export async function routeAuthRequest({ pathname, method, request, env, db, ctx }) {
  if (pathname === '/api/auth/register' && method === 'POST') return await handleRegister(request, env, db);
  if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(request, env, db);
  if (pathname === '/api/auth/user-info' && method === 'GET') return await handleGetUserInfo(request, env, db);
  if (pathname === '/api/auth/send-verification-code' && method === 'POST') {
    return await handleSendVerificationCode(request, env, ctx);
  }
  if (pathname === '/api/auth/forgot-password' && method === 'POST') return await handleForgotPassword(request, env, db);
  if (pathname === '/api/auth/reset-password' && method === 'POST') return await handleResetPassword(request, env, db);
  if (pathname === '/api/auth/bind-email' && method === 'POST') return await handleBindEmail(request, env, db);
  if (pathname === '/api/auth/update-profile' && method === 'POST') return await handleUpdateProfile(request, env, db);
  if (pathname === '/api/auth/firebase-phone-login' && method === 'POST') {
    return await handleFirebasePhoneLogin(request, env, db);
  }
  if (pathname === '/api/auth/apple-login' && method === 'POST') return await handleAppleLogin(request, env, db);
  if (pathname === '/api/auth/delete' && method === 'DELETE') return await handleDeleteAccount(request, env, db);

  if (pathname === '/api/auth/wechat/login-url' && method === 'GET') return await handleGetWechatLoginUrl(request, env);
  if (pathname === '/api/auth/alipay/login-url' && method === 'GET') return await handleGetAlipayLoginUrl(request, env);
  if (pathname === '/api/auth/alipay/login' && method === 'POST') return await handleAlipayLogin(request, env);
  if (pathname === '/api/auth/alipay/register' && method === 'POST') return await handleAlipayRegister(request, env);
  if (pathname === '/api/auth/alipay/macos-callback' && method === 'GET') return await handleMacOSAlipayCallback(request, env);
  if (pathname === '/api/auth/alipay/mobile-callback' && method === 'GET') return await handleMobileAlipayCallback(request, env);
  if (pathname === '/api/auth/alipay/auth-string' && method === 'GET') return await handleGetAlipayAuthString(request, env);
  if (pathname === '/api/auth/alipay/sdk-login' && method === 'POST') return await handleAlipaySDKLogin(request, env);

  return null;
}
