import { createPasswordHash } from '../../auth-utils.js';
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

export async function registerAccountCommand(body, env, repository) {
  const { username, email, password, verificationCode, nickname, avatar } = body;

  if (!username || !email || !password || !verificationCode) {
    throw new ApiError('缺少必要字段', 400);
  }

  const normalizedUsername = normalizeRequiredString(username);
  const normalizedEmail = normalizeRequiredString(email).toLowerCase();
  const normalizedNickname = normalizeOptionalString(nickname) || normalizedUsername;
  const normalizedAvatar = normalizeOptionalString(avatar);

  if (normalizedUsername.includes('@') || /\s/.test(normalizedUsername)) {
    throw new ApiError('用户名不能包含 @ 或空格', 400);
  }

  const verifyData = await env.USERS_KV.get(`verify:${normalizedEmail}`);
  if (!verifyData) {
    throw new ApiError('验证码不存在或已过期', 400);
  }

  const { code, expiry } = JSON.parse(verifyData);
  if (Date.now() > expiry || verificationCode !== code) {
    throw new ApiError('验证码错误或已过期', 400);
  }

  const existingUser = await repository.getByUsername(normalizedUsername);
  if (existingUser) {
    throw new ApiError('用户名已存在', 400);
  }

  const existingEmail = await repository.getByEmail(normalizedEmail);
  if (existingEmail) {
    throw new ApiError('该邮箱已被注册', 400);
  }

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

  await env.USERS_KV.delete(`verify:${normalizedEmail}`);

  return { message: '注册成功' };
}
