import { createPasswordHash } from '../../auth-utils.js';
import { buildProfileUpdatedPayload, serializeAccountUser } from '../contracts/account-user.js';
import { ApiError } from '../contracts/api-error.js';
import { normalizeProfileUpdateBody } from '../domain/account-identity.js';
import { authenticateRequest } from './authenticated-user.js';

export async function updateProfileFromRequest(request, env, repository) {
  const { user } = await authenticateRequest(request, env, repository);
  const body = await request.json();
  return await updateProfileCommand({ currentUser: user, body }, repository);
}

export async function updateProfileCommand({ currentUser, body }, repository) {
  let normalized;
  try {
    normalized = normalizeProfileUpdateBody(body);
  } catch (error) {
    throw new ApiError(error.message, 400);
  }

  const { hasDisplayNameField, displayName, email, phoneNumber, password } = normalized;
  if (hasDisplayNameField && !displayName) {
    throw new ApiError('请输入昵称', 400);
  }

  if (email !== undefined && email) {
    const existingUser = await repository.getByEmail(email);
    if (existingUser && existingUser.id !== currentUser.id) {
      throw new ApiError('该邮箱已被其他账号使用', 400);
    }
  }

  if (phoneNumber !== undefined && phoneNumber) {
    const existingUser = await repository.getByPhone(phoneNumber);
    if (existingUser && existingUser.id !== currentUser.id) {
      throw new ApiError('该手机号已被其他账号使用', 400);
    }
  }

  const updates = {};
  if (displayName !== undefined) updates.nickname = displayName;
  if (email !== undefined) {
    updates.email = email || '';
    updates.email_verified = email ? 1 : 0;
  }
  if (phoneNumber !== undefined) updates.phone_number = phoneNumber;
  if (password !== undefined && password.length > 0) {
    if (currentUser.password_hash && currentUser.salt) {
      throw new ApiError('当前账号已设置密码，请使用修改密码功能', 400);
    }
    if (password.length < 6 || password.length > 128) {
      throw new ApiError('密码长度需为 6-128 位', 400);
    }
    const passwordCreds = await createPasswordHash(password);
    updates.password_hash = passwordCreds.passwordHash;
    updates.salt = passwordCreds.salt;
    updates.iterations = passwordCreds.iterations;
    updates.algo = passwordCreds.algo;
  }

  if (!Object.keys(updates).length) {
    return {
      message: '没有需要更新的字段',
      user: serializeAccountUser(currentUser),
    };
  }

  await repository.updateById(currentUser.id, updates);
  if (email !== undefined) {
    await repository.replaceEmailMapping({
      userId: currentUser.id,
      username: currentUser.username,
      oldEmail: currentUser.email,
      newEmail: email,
    });
  }

  const updatedUser = (await repository.getById(currentUser.id)) || currentUser;
  return buildProfileUpdatedPayload(updatedUser);
}
