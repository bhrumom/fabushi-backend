import { createPasswordHash, timingSafeEqualBytes } from '../../auth-utils.js';
import { calculateTrialEndDate } from '../../stripe-config.js';
import { ApiError } from '../contracts/api-error.js';

function normalizeRequiredString(value) {
  return String(value || '').trim();
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length === 0 ? null : normalized;
}

function safeCodeEqual(left, right) {
  const encoder = new TextEncoder();
  return timingSafeEqualBytes(encoder.encode(String(left || '')), encoder.encode(String(right || '')));
}

export async function registerAccountCommand(body, env, repository) {
  const { username, email, password, verificationCode, nickname, avatar } = body;

  if (!username || !email || !password || !verificationCode) {
    throw new ApiError('缺少必要字段', 400);
  }

  const normalizedUsername = normalizeRequiredString(username);
  const normalizedEmail = normalizeRequiredString(email).toLowerCase();
  const normalizedNickname = normalizeOptionalString(nickname) || normalizedUsername;
  const normalizedAvatar = normalizeOptionalString(avatar);

  if (normalizedUsername.length < 2 || normalizedUsername.length > 64 || normalizedUsername.includes('@') || /\s/.test(normalizedUsername)) {
    throw new ApiError('用户名格式无效', 400);
  }
  if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new ApiError('邮箱格式无效', 400);
  }
  if (!/^\d{6}$/.test(String(verificationCode))) {
    throw new ApiError('验证码格式无效', 400);
  }

  const verificationKey = `verify:${normalizedEmail}`;
  const verifyData = await env.USERS_KV.get(verificationKey);
  if (!verifyData) throw new ApiError('验证码不存在或已过期', 400);

  let challenge;
  try {
    challenge = JSON.parse(verifyData);
  } catch {
    await env.USERS_KV.delete(verificationKey);
    throw new ApiError('验证码不存在或已过期', 400);
  }

  const attempts = Number(challenge.attempts || 0);
  const expiry = Number(challenge.expiry || 0);
  if (attempts >= 5 || !Number.isFinite(expiry) || Date.now() > expiry) {
    await env.USERS_KV.delete(verificationKey);
    throw new ApiError('验证码不存在或已过期', 400);
  }

  if (!safeCodeEqual(verificationCode, challenge.code)) {
    const remainingSeconds = Math.max(1, Math.floor((expiry - Date.now()) / 1000));
    await env.USERS_KV.put(
      verificationKey,
      JSON.stringify({ ...challenge, attempts: attempts + 1 }),
      { expirationTtl: remainingSeconds },
    );
    throw new ApiError('验证码错误或已过期', 400);
  }

  const existingUser = await repository.getByUsername(normalizedUsername);
  if (existingUser) throw new ApiError('用户名已存在', 400);

  const existingEmail = await repository.getByEmail(normalizedEmail);
  if (existingEmail) throw new ApiError('该邮箱已被注册', 400);

  const creds = await createPasswordHash(password);
  const trialEndDate = calculateTrialEndDate();

  await repository.createRegisteredUser({
    username: normalizedUsername,
    email: normalizedEmail,
    passwordHash: creds.passwordHash,
    salt: creds.salt,
    iterations: creds.iterations,
    algo: creds.algo,
    emailVerified: true,
    nickname: normalizedNickname,
    avatar: normalizedAvatar,
    membershipType: 'trial',
    freeTrialEndDate: trialEndDate.toISOString(),
    createdAt: new Date().toISOString(),
  });

  await env.USERS_KV.delete(verificationKey);
  return { message: '注册成功' };
}
