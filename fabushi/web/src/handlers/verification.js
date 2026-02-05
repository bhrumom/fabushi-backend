import { jsonResponse } from '../utils/response.js';

// 发送验证码
export async function handleSendVerificationCode(request, env, ctx) {
  const { email, type = 'register' } = await request.json();
  if (!email) return jsonResponse({ error: '邮箱地址不能为空' }, 400);

  const normalizedEmail = email.toLowerCase();
  const rateKey = `rate:verify:${normalizedEmail}`;
  
  if (await env.USERS_KV.get(rateKey)) {
    return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429);
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiry = Date.now() + 10 * 60 * 1000;

  await env.USERS_KV.put(`verify:${normalizedEmail}`, JSON.stringify({ code, expiry, type }));
  await env.USERS_KV.put(rateKey, '1', { expirationTtl: 60 });

  // 发送邮件（后台）
  const subject = type === 'register' ? '注册验证码' : '密码重置验证码';
  const body = `您的验证码是：${code}\n有效期10分钟，请尽快使用。`;
  
  ctx.waitUntil(sendEmail(normalizedEmail, subject, body, env));

  return jsonResponse({ message: '验证码已发送，请查收邮件。' });
}

// 忘记密码
export async function handleForgotPassword(request, env, db) {
  const { email } = await request.json();
  if (!email) return jsonResponse({ error: '邮箱地址不能为空' }, 400);

  const user = await db.getUserByEmail(email.toLowerCase());
  if (!user) return jsonResponse({ error: '该邮箱未注册' }, 400);

  const resetToken = crypto.randomUUID();
  await env.USERS_KV.put(`reset:${email.toLowerCase()}`, resetToken, { expirationTtl: 30 * 60 });

  const resetUrl = `${new URL(request.url).origin}/reset-password.html?token=${resetToken}&email=${email}`;
  await sendEmail(email, '密码重置请求', `点击以下链接重置您的密码：\n${resetUrl}\n链接30分钟内有效。`, env);

  return jsonResponse({ message: '重置邮件已发送' });
}

// 重置密码
export async function handleResetPassword(request, env, db) {
  const { email, token, newPassword } = await request.json();
  if (!email || !token || !newPassword) return jsonResponse({ error: '缺少必要字段' }, 400);

  const storedToken = await env.USERS_KV.get(`reset:${email.toLowerCase()}`);
  if (!storedToken || storedToken !== token) {
    return jsonResponse({ error: '重置链接无效或已过期' }, 400);
  }

  const user = await db.getUserByEmail(email.toLowerCase());
  if (!user) return jsonResponse({ error: '用户不存在' }, 400);

  const { createPasswordHash } = await import('../../auth-utils.js');
  const creds = await createPasswordHash(newPassword);
  
  await db.updateUser(user.username, {
    password_hash: creds.passwordHash,
    salt: creds.salt,
    iterations: creds.iterations,
    algo: creds.algo
  });

  await env.USERS_KV.delete(`reset:${email.toLowerCase()}`);
  return jsonResponse({ message: '密码重置成功' });
}

async function sendEmail(to, subject, body, env) {
  // 邮件发送逻辑（保持原有实现）
  if (env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'onboarding@resend.dev',
        to: [to],
        subject,
        text: body
      })
    });
  }
}
