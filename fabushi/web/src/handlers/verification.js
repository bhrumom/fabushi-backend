import { jsonResponse } from '../utils/response.js';
import { sendSystemMail, systemMailConfigured } from '../utils/system-mail.js';
import { createPasswordHash } from '../../auth-utils.js';

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function generateSixDigitCode() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(100000 + (bytes[0] % 900000));
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ''));
  const b = new TextEncoder().encode(String(right || ''));
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function handleSendVerificationCode(request, env) {
  const { email: input, type = 'register' } = await request.json();
  const email = normalizeEmail(input);
  if (!email || !['register', 'reset'].includes(type)) return jsonResponse({ error: '邮箱地址或验证码类型无效' }, 400);
  if (!systemMailConfigured(env)) return jsonResponse({ error: '邮件服务暂不可用' }, 503);

  const rateKey = `rate:verify:${email}`;
  if (await env.USERS_KV.get(rateKey)) return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429);

  const code = generateSixDigitCode();
  const expiry = Date.now() + 10 * 60 * 1000;
  await env.USERS_KV.put(`verify:${email}`, JSON.stringify({ code, expiry, type, attempts: 0 }), { expirationTtl: 600 });
  await env.USERS_KV.put(rateKey, '1', { expirationTtl: 60 });

  const subject = type === 'register' ? '注册验证码' : '密码重置验证码';
  try {
    await sendSystemMail({ email, subject, text: `您的验证码是：${code}\n有效期10分钟，请尽快使用。` }, env);
  } catch {
    await Promise.all([env.USERS_KV.delete(`verify:${email}`), env.USERS_KV.delete(rateKey)]);
    return jsonResponse({ error: '验证码邮件发送失败，请稍后再试' }, 502);
  }
  return jsonResponse({ message: '验证码已发送，请查收邮件。' });
}

export async function handleForgotPassword(request, env, db) {
  const { email: input } = await request.json();
  const email = normalizeEmail(input);
  if (!email) return jsonResponse({ error: '邮箱地址无效' }, 400);
  if (!systemMailConfigured(env)) return jsonResponse({ error: '邮件服务暂不可用' }, 503);

  const rateKey = `rate:reset:${email}`;
  if (await env.USERS_KV.get(rateKey)) return jsonResponse({ message: '如果该邮箱已注册，重置邮件将会发送。' });
  await env.USERS_KV.put(rateKey, '1', { expirationTtl: 120 });

  const user = await db.getUserByEmail(email);
  if (!user) return jsonResponse({ message: '如果该邮箱已注册，重置邮件将会发送。' });

  const resetToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  await env.USERS_KV.put(`reset:${email}`, resetToken, { expirationTtl: 30 * 60 });
  const origin = new URL(request.url).origin;
  const resetUrl = new URL('/reset-password.html', origin);
  resetUrl.searchParams.set('token', resetToken);
  resetUrl.searchParams.set('email', email);
  try {
    await sendSystemMail({
      email,
      subject: '密码重置请求',
      text: `点击以下链接重置您的密码：\n${resetUrl.toString()}\n链接30分钟内有效。`,
    }, env);
  } catch {
    await env.USERS_KV.delete(`reset:${email}`);
    console.error('Password reset email delivery failed');
  }

  // Deliberately identical whether the account exists or mail delivery succeeds.
  return jsonResponse({ message: '如果该邮箱已注册，重置邮件将会发送。' });
}

export async function handleResetPassword(request, env, db) {
  const { email: input, token, newPassword } = await request.json();
  const email = normalizeEmail(input);
  if (!email || !token || !newPassword) return jsonResponse({ error: '缺少或无效的必要字段' }, 400);
  if (String(token).length < 64 || String(token).length > 256) return jsonResponse({ error: '重置链接无效或已过期' }, 400);

  const key = `reset:${email}`;
  const storedToken = await env.USERS_KV.get(key);
  if (!storedToken || !constantTimeEqual(storedToken, token)) return jsonResponse({ error: '重置链接无效或已过期' }, 400);
  const user = await db.getUserByEmail(email);
  if (!user) return jsonResponse({ error: '重置链接无效或已过期' }, 400);

  let creds;
  try {
    creds = await createPasswordHash(newPassword);
  } catch (error) {
    return jsonResponse({ error: error?.message || '密码不符合要求' }, 400);
  }
  await db.updateUser(user.username, {
    password_hash: creds.passwordHash,
    salt: creds.salt,
    iterations: creds.iterations,
    algo: creds.algo,
    password: null
  });
  await env.USERS_KV.delete(key);
  return jsonResponse({ message: '密码重置成功' });
}
