import { authenticateRequest } from './authenticated-user.js';

async function clearLeaderboardCaches(env) {
  await Promise.allSettled([
    env.USERS_KV?.delete('leaderboard:cache'),
    env.USERS_KV?.delete('leaderboard:cache:v2'),
    env.USERS_KV?.delete('leaderboard:practice:v2'),
    env.USERS_KV?.delete('leaderboard:practice:v3'),
    env.USERS_KV?.delete('leaderboard:practice:v4'),
  ]);
}

export async function deleteAccountCommand(request, env, repository) {
  const { user } = await authenticateRequest(request, env, repository);

  await repository.withTransaction(async () => {
    await repository.deleteAccountArtifacts({
      userId: user.id,
      username: user.username,
      email: user.email,
    });
    await repository.deleteByUsername(user.username);
  });

  await clearLeaderboardCaches(env);

  return {
    success: true,
    message: '账户已注销',
  };
}
