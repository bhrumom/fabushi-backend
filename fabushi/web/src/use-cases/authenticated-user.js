import { verifyToken } from '../../auth-utils.js';
import { ApiError } from '../contracts/api-error.js';
import { serializeAccountUser } from '../contracts/account-user.js';

export async function authenticateRequest(request, env, repository) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError('未提供认证信息', 401);
  }

  const tokenData = await verifyToken(authHeader.substring(7), env);
  if (!tokenData) {
    throw new ApiError('认证失败，请重新登录', 401);
  }

  const user = await repository.resolveTokenUser(tokenData);
  if (!user) {
    throw new ApiError('用户不存在', 404);
  }

  return { tokenData, user };
}

export async function getAuthenticatedUserInfo(request, env, repository) {
  const { user } = await authenticateRequest(request, env, repository);
  return serializeAccountUser(user);
}
