import { createPasswordHash, generateToken } from '../../auth-utils.js';
import { buildProfileUpdatedPayload, serializeAccountUser } from '../contracts/account-user.js';
import { ApiError } from '../contracts/api-error.js';
import { normalizeProfileUpdateBody } from '../domain/account-identity.js';
import { authenticateRequest } from './authenticated-user.js';

const USERNAME_CHANGE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

function parseIsoDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp);
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function sanitizeAvatarExtension(fileName, contentType) {
  const fallbackExtension = String(contentType || 'image/jpeg')
    .split('/')
    .pop()
    ?.replace('jpeg', 'jpg') || 'jpg';
  const explicitExtension = String(fileName || '').split('.').pop()?.toLowerCase() || '';

  if (/^[a-z0-9]{2,5}$/.test(explicitExtension)) {
    return explicitExtension;
  }

  return fallbackExtension;
}

function decodeBase64Image(imageBase64) {
  const raw = String(imageBase64 || '').trim();
  if (!raw) {
    throw new ApiError('头像图片为空', 400);
  }

  const payload = raw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (_) {
    throw new ApiError('头像图片数据格式无效', 400);
  }
}

function avatarUrlFor(request, key) {
  const url = new URL(request.url);
  return `${url.origin}/r2?file=${encodeURIComponent(key)}`;
}

async function uploadAvatarObject({ request, env, username, avatarData }) {
  if (!avatarData?.imageBase64) {
    return null;
  }

  if (!env.R2_BUCKET) {
    throw new ApiError('R2存储桶未绑定，无法保存头像到云端', 500);
  }

  const bytes = decodeBase64Image(avatarData.imageBase64);
  if (!bytes.length) {
    throw new ApiError('头像图片为空', 400);
  }
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new ApiError('头像图片不能超过 3MB', 413);
  }

  const rawContentType = String(avatarData.contentType || '').trim().toLowerCase();
  const contentType = rawContentType.startsWith('image/')
    ? rawContentType
    : 'image/jpeg';
  const extension = sanitizeAvatarExtension(avatarData.fileName, contentType);
  const objectKey = `avatars/${encodeURIComponent(username)}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

  await env.R2_BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType },
    customMetadata: { username },
  });

  return avatarUrlFor(request, objectKey);
}

export async function updateProfileFromRequest(request, env, repository) {
  const { user } = await authenticateRequest(request, env, repository);
  const body = await request.json();
  return await updateProfileCommand({ currentUser: user, body, env, request }, repository);
}

export async function updateProfileCommand({ currentUser, body, env, request }, repository) {
  let normalized;
  try {
    normalized = normalizeProfileUpdateBody(body, currentUser.username);
  } catch (error) {
    throw new ApiError(error.message, 400);
  }

  const {
    hasDisplayNameField,
    displayName,
    username,
    email,
    phoneNumber,
    avatar,
    password,
  } = normalized;
  const avatarData = body?.avatarData && typeof body.avatarData === 'object'
    ? body.avatarData
    : null;

  if (hasDisplayNameField && !displayName) {
    throw new ApiError('请输入昵称', 400);
  }

  if (username !== undefined && username !== currentUser.username) {
    const lastChangedAt = parseIsoDate(currentUser.username_changed_at);
    if (lastChangedAt) {
      const nextAllowedAt = new Date(lastChangedAt.getTime() + USERNAME_CHANGE_WINDOW_MS);
      if (nextAllowedAt.getTime() > Date.now()) {
        throw new ApiError(`用户名一年只能修改一次，请在${formatDateOnly(nextAllowedAt)}后再试`, 400);
      }
    }

    const existingUser = await repository.getByUsername(username);
    if (existingUser && existingUser.id !== currentUser.id) {
      throw new ApiError('用户名已存在', 400);
    }
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
  if (username !== undefined && username !== currentUser.username) {
    updates.username = username;
    updates.username_changed_at = new Date().toISOString();
  }
  if (hasDisplayNameField) updates.nickname = displayName;
  if (email !== undefined) {
    updates.email = email || '';
    updates.email_verified = email ? 1 : 0;
  }
  if (phoneNumber !== undefined) updates.phone_number = phoneNumber;

  if (avatarData?.imageBase64) {
    const resolvedUsername = updates.username || currentUser.username;
    updates.avatar = await uploadAvatarObject({
      request,
      env,
      username: resolvedUsername,
      avatarData,
    });
  } else if (avatar !== undefined) {
    updates.avatar = avatar;
  }

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
  const updatedUser = (await repository.getById(currentUser.id)) || { ...currentUser, ...updates };

  if (username !== undefined && username !== currentUser.username) {
    await repository.renameUsernameReferences({
      userId: currentUser.id,
      oldUsername: currentUser.username,
      newUsername: updatedUser.username,
    });
  }

  const resolvedEmail = email !== undefined ? email : currentUser.email;
  if (resolvedEmail || email !== undefined) {
    await repository.replaceEmailMapping({
      userId: currentUser.id,
      username: updatedUser.username,
      oldEmail: currentUser.email,
      newEmail: resolvedEmail,
    });
  }

  const token = username !== undefined && username !== currentUser.username
    ? await generateToken({ id: updatedUser.id, username: updatedUser.username }, env)
    : undefined;

  return buildProfileUpdatedPayload(updatedUser, token);
}
