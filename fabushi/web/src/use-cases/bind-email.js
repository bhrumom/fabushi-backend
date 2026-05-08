import { ApiError } from '../contracts/api-error.js';
import { normalizeEmail } from '../domain/account-identity.js';
import { authenticateRequest } from './authenticated-user.js';

export async function bindEmailFromRequest(request, env, repository) {
  const { user } = await authenticateRequest(request, env, repository);
  const { email } = await request.json();
  return await bindEmailCommand({ currentUser: user, email }, repository);
}

export async function bindEmailCommand({ currentUser, email }, repository) {
  if (!email) {
    throw new ApiError('邮箱与验证码不能为空', 400);
  }

  let normalizedEmail;
  try {
    normalizedEmail = normalizeEmail(email);
  } catch (error) {
    throw new ApiError(error.message, 400);
  }

  if (!normalizedEmail) {
    throw new ApiError('邮箱与验证码不能为空', 400);
  }

  const existing = await repository.getByEmail(normalizedEmail);
  if (existing && existing.id !== currentUser.id) {
    throw new ApiError('该邮箱已被其他账号绑定', 400);
  }

  await repository.updateById(currentUser.id, {
    email: normalizedEmail,
    email_verified: 1,
  });
  await repository.replaceEmailMapping({
    userId: currentUser.id,
    username: currentUser.username,
    oldEmail: currentUser.email,
    newEmail: normalizedEmail,
  });

  return {
    message: '邮箱绑定成功',
    email: normalizedEmail,
  };
}
