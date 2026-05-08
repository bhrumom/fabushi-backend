import { jsonResponse } from '../utils/response.js';
import { AccountUserRepository } from '../repositories/account-user-repository.js';
import { asApiError } from '../contracts/api-error.js';
import { loginWithPasswordCommand } from '../use-cases/password-login.js';

export async function handlePasswordLogin(request, env, db) {
  const repository = new AccountUserRepository(db);

  try {
    const { username: loginIdentifier, password } = await request.json();
    const payload = await loginWithPasswordCommand(
      { identifier: loginIdentifier, password },
      env,
      repository
    );
    return jsonResponse(payload);
  } catch (error) {
    const apiError = asApiError(error, '登录失败');
    return jsonResponse({ error: apiError.message }, apiError.status);
  }
}
