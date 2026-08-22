import { generateToken } from '../../auth-utils.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function normalizePhone(value) {
  const phone = String(value || '').trim().replace(/[\s()-]/g, '');
  return /^\+?[1-9]\d{7,14}$/.test(phone) ? phone : '';
}

function generateCode() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(100000 + (bytes[0] % 900000));
}

async function sendSms(phoneNumber, code, env) {
  const endpoint = String(env.SMS_PROVIDER_URL || '').trim();
  const token = String(env.SMS_PROVIDER_TOKEN || '').trim();
  if (!endpoint || !token) {
    if (env.ENVIRONMENT === 'development' && env.SMS_DEBUG_CODES === 'true') return { debug: true };
    throw new Error('SMS provider is not configured');
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('SMS provider endpoint must use HTTPS');
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ phoneNumber, code, purpose: 'login' }),
  });
  if (!response.ok) throw new Error(`SMS provider rejected request: ${response.status}`);
  return { debug: false };
}

export async function handleSendSmsCode(request, env) {
  try {
    const { phoneNumber: input } = await request.json();
    const phoneNumber = normalizePhone(input);
    if (!phoneNumber) return json({ success: false, error: '请输入有效的手机号' }, 400);

    const cooldownKey = `sms_cooldown_${phoneNumber}`;
    if (await env.USERS_KV.get(cooldownKey)) {
      return json({ success: false, error: '请求过于频繁，请稍后再试' }, 429);
    }

    const code = generateCode();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const delivery = await sendSms(phoneNumber, code, env);
    await Promise.all([
      env.USERS_KV.put(`sms_code_${phoneNumber}`, JSON.stringify({ code, expiresAt, attempts: 0 }), { expirationTtl: 300 }),
      env.USERS_KV.put(cooldownKey, '1', { expirationTtl: 60 }),
    ]);

    return json({
      success: true,
      message: '验证码已发送',
      ...(delivery.debug ? { debugCode: code } : {}),
    });
  } catch (error) {
    console.error('发送验证码失败:', error?.message || error);
    const unavailable = String(error?.message || '').includes('not configured');
    return json({ success: false, error: unavailable ? '短信服务暂不可用' : '发送验证码失败' }, unavailable ? 503 : 502);
  }
}

export async function handleSmsLogin(request, env, db) {
  try {
    const { phoneNumber: input, code: inputCode } = await request.json();
    const phoneNumber = normalizePhone(input);
    const code = String(inputCode || '').trim();
    if (!phoneNumber || !/^\d{6}$/.test(code)) return json({ success: false, error: '手机号或验证码无效' }, 400);

    const key = `sms_code_${phoneNumber}`;
    const storedData = await env.USERS_KV.get(key);
    if (!storedData) return json({ success: false, error: '验证码已过期，请重新获取' }, 400);
    const stored = JSON.parse(storedData);
    const attempts = Number(stored.attempts || 0);
    if (attempts >= 5 || Date.now() > Number(stored.expiresAt || 0)) {
      await env.USERS_KV.delete(key);
      return json({ success: false, error: '验证码已失效，请重新获取' }, 400);
    }

    let difference = 0;
    for (let i = 0; i < 6; i += 1) difference |= code.charCodeAt(i) ^ String(stored.code).charCodeAt(i);
    if (difference !== 0) {
      const ttl = Math.max(1, Math.floor((Number(stored.expiresAt) - Date.now()) / 1000));
      await env.USERS_KV.put(key, JSON.stringify({ ...stored, attempts: attempts + 1 }), { expirationTtl: ttl });
      return json({ success: false, error: '验证码错误' }, 400);
    }
    await env.USERS_KV.delete(key);

    let user = await db.getUserByPhone(phoneNumber);
    let isNewUser = false;
    if (!user) {
      isNewUser = true;
      const username = `user_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const now = new Date().toISOString();
      const trialEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      await db.createPhoneUser({
        username,
        email: `${phoneNumber.replace(/[^0-9]/g, '')}@phone.user`,
        phoneNumber,
        firebaseUid: null,
        membershipType: 'trial',
        freeTrialEndDate: trialEnd,
        createdAt: now
      });
      user = await db.getUserByPhone(phoneNumber);
    }
    if (!user) throw new Error('SMS user creation failed');

    const token = await generateToken({ id: user.id, username: user.username }, env);
    return json({
      success: true,
      token,
      username: user.username,
      userId: user.id,
      isNewUser,
      user: {
        username: user.username,
        email: user.email,
        nickname: user.nickname || null,
        avatar: user.avatar || user.alipay_avatar || user.wechat_headimgurl || null,
        phoneNumber: user.phone_number,
        firebaseUid: user.firebase_uid || null,
        membership: {
          type: user.membership_type || 'trial',
          expiresAt: user.membership_expires_at || user.free_trial_end_date || null
        }
      }
    });
  } catch (error) {
    console.error('验证码登录失败:', error?.message || error);
    return json({ success: false, error: '登录失败' }, 500);
  }
}
