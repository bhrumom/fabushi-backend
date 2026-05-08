import { verifyPassword, generateToken } from '../../auth-utils.js';
import { buildPasswordLoginPayload } from '../contracts/account-user.js';
import { ApiError } from '../contracts/api-error.js';

function looksLikeEmail(value) {
  return String(value || '').includes('@');
}

function looksLikePhone(value) {
  return /^\+?[0-9]{6,20}$/.test(String(value || '').trim());
}

async function resolveLoginUser(repository, identifier) {
  if (looksLikeEmail(identifier)) {
    return await repository.getByEmail(identifier.toLowerCase());
  }
  if (looksLikePhone(identifier)) {
    return await repository.getByPhone(identifier);
  }
  return await repository.getByUsername(identifier);
}

export async function loginWithPasswordCommand({ identifier, password }, env, repository) {
  const normalizedIdentifier = String(identifier || '').trim();
  if (!normalizedIdentifier || !password) {
    throw new ApiError('手机号、用户名或邮箱和密码不能为空', 400);
  }

  const user = await resolveLoginUser(repository, normalizedIdentifier);
  if (!user) {
    throw new ApiError('用户不存在', 401);
  }
  if (!user.password_hash || !user.salt) {
    throw new ApiError('当前账号尚未设置密码，请先通过已登录资料页设置密码', 401);
  }

  const ok = await verifyPassword(password, {
    passwordHash: user.password_hash,
    salt: user.salt,
    iterations: user.iterations,
    algo: user.algo,
  });
  if (!ok) {
    throw new ApiError('密码错误', 401);
  }

  const token = await generateToken({ id: user.id, username: user.username }, env);
  return buildPasswordLoginPayload({ token, user });
}
