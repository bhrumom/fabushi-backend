import { jsonResponse } from '../utils/response.js';
import { serializeAccountUser } from '../contracts/account-user.js';
import { AccountUserRepository } from '../repositories/account-user-repository.js';
import { asApiError } from '../contracts/api-error.js';
import { authenticateRequest } from '../use-cases/authenticated-user.js';
import { updateProfileFromRequest } from '../use-cases/update-profile.js';

const MAX_INLINE_AVATAR_BYTES = 512 * 1024;

function estimateBase64Bytes(base64) {
  return Math.floor((base64.length * 3) / 4);
}

function inferImageMimeType(base64) {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

function normalizeAvatarDataUrl(imageBase64) {
  const raw = String(imageBase64 || '').trim();
  if (!raw) return null;

  if (raw.startsWith('data:image/')) {
    const commaIndex = raw.indexOf(',');
    if (commaIndex === -1) return null;

    const base64Payload = raw.slice(commaIndex + 1).replace(/\s/g, '');
    if (!base64Payload) return null;
    if (estimateBase64Bytes(base64Payload) > MAX_INLINE_AVATAR_BYTES) {
      return { error: '头像图片过大，请选择 512KB 以内的图片', status: 413 };
    }

    return raw.slice(0, commaIndex + 1) + base64Payload;
  }

  const normalizedBase64 = raw.replace(/\s/g, '');
  if (!normalizedBase64) return null;
  if (estimateBase64Bytes(normalizedBase64) > MAX_INLINE_AVATAR_BYTES) {
    return { error: '头像图片过大，请选择 512KB 以内的图片', status: 413 };
  }

  return `data:${inferImageMimeType(normalizedBase64)};base64,${normalizedBase64}`;
}

export async function handleUploadAvatar(request, env, db) {
  const repository = new AccountUserRepository(db);

  try {
    const { user } = await authenticateRequest(request, env, repository);
    const { imageBase64 } = await request.json();
    if (!imageBase64) {
      return jsonResponse({ error: '缺少头像图片数据' }, 400);
    }

    const avatarDataUrl = normalizeAvatarDataUrl(imageBase64);
    if (!avatarDataUrl) {
      return jsonResponse({ error: '头像图片数据格式无效' }, 400);
    }
    if (avatarDataUrl.error) {
      return jsonResponse({ error: avatarDataUrl.error }, avatarDataUrl.status);
    }

    await repository.updateById(user.id, {
      avatar: avatarDataUrl,
      nickname: user.nickname || user.username,
    });

    const updatedUser = (await repository.getById(user.id)) || user;
    return jsonResponse({
      success: true,
      avatar: avatarDataUrl,
      user: serializeAccountUser(updatedUser),
    });
  } catch (error) {
    const apiError = asApiError(error, '头像上传失败');
    return jsonResponse({ error: apiError.message }, apiError.status);
  }
}

export async function handleUpdateProfile(request, env, db) {
  const repository = new AccountUserRepository(db);

  try {
    const payload = await updateProfileFromRequest(request, env, repository);
    return jsonResponse(payload);
  } catch (error) {
    const apiError = asApiError(error, '更新个人资料失败');
    console.error('更新个人资料失败:', error);
    return jsonResponse({ error: apiError.message }, apiError.status);
  }
}
