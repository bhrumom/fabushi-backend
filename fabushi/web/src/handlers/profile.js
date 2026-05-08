import { jsonResponse } from '../utils/response.js';
import { serializeAccountUser } from '../contracts/account-user.js';
import { AccountUserRepository } from '../repositories/account-user-repository.js';
import { asApiError } from '../contracts/api-error.js';
import { authenticateRequest } from '../use-cases/authenticated-user.js';
import { updateProfileFromRequest } from '../use-cases/update-profile.js';

export async function handleUploadAvatar(request, env, db) {
  const repository = new AccountUserRepository(db);

  try {
    const { user } = await authenticateRequest(request, env, repository);
    const { imageBase64 } = await request.json();
    if (!imageBase64) {
      return jsonResponse({ error: '缺少头像图片数据' }, 400);
    }

    const avatarUrl = `https://example.com/avatar/${user.id}`;
    await repository.updateById(user.id, {
      avatar: avatarUrl,
      nickname: user.nickname || user.username,
    });

    const updatedUser = (await repository.getById(user.id)) || user;
    return jsonResponse({
      success: true,
      avatar: avatarUrl,
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
