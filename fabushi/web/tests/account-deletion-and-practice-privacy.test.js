import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const authHandler = readFileSync(join(webRoot, 'src/handlers/auth.js'), 'utf8');
const deleteAccountUseCase = readFileSync(join(webRoot, 'src/use-cases/delete-account.js'), 'utf8');
const accountCommandRepository = readFileSync(
  join(webRoot, 'src/repositories/account-user-command-repository.js'),
  'utf8'
);
const leaderboardHandler = readFileSync(join(webRoot, 'src/handlers/leaderboard.js'), 'utf8');

test('practice leaderboard filters out deleted users instead of keeping orphaned records visible', () => {
  assert.match(leaderboardHandler, /FROM meditation_records mr\s+JOIN users u ON mr\.username = u\.username/s);
  assert.doesNotMatch(leaderboardHandler, /FROM meditation_records mr\s+LEFT JOIN users u ON mr\.username = u\.username/s);
});

test('account deletion purges meditation and social artifacts before removing the user', () => {
  assert.match(authHandler, /deleteAccountCommand\(request, env, repository\)/);
  assert.match(deleteAccountUseCase, /await repository\.withTransaction\(async \(\) => \{/);
  assert.match(deleteAccountUseCase, /await repository\.deleteAccountArtifacts\(\{/);
  assert.match(deleteAccountUseCase, /await repository\.deleteByUsername\(user\.username\);/);
  assert.match(deleteAccountUseCase, /await clearLeaderboardCaches\(env\);/);
  assert.match(accountCommandRepository, /async deleteAccountArtifacts\(\{ userId, username, email \}\)/);
  assert.match(accountCommandRepository, /stableUserId/);
  assert.match(accountCommandRepository, /DELETE FROM meditation_records WHERE user_id = \? OR username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM user_practice_privacy WHERE user_id = \? OR username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM user_follows WHERE follower_user_id = \? OR following_user_id = \?/);
  assert.match(accountCommandRepository, /DELETE FROM comments WHERE account_user_id = \? OR username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM content_likes WHERE account_user_id = \? OR username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM content_favorites WHERE user_id = \? OR username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM meditation_records WHERE username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM meditation_goals WHERE username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM meditation_settings WHERE username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM user_practice_privacy WHERE username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM meditation_groups WHERE owner_username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM meditation_group_members WHERE group_id IN \(SELECT id FROM meditation_groups WHERE owner_username = \?\)/);
  assert.match(accountCommandRepository, /DELETE FROM user_follows WHERE follower_username = \? OR following_username = \?/);
});

test('account deletion avoids unsupported SQL transactions on Cloudflare storage', () => {
  assert.match(accountCommandRepository, /typeof this\.db\.transaction === 'function'/);
  assert.match(accountCommandRepository, /storage\.transaction/);
  assert.match(accountCommandRepository, /return await action\(\);/);
  assert.doesNotMatch(accountCommandRepository, /BEGIN TRANSACTION|SAVEPOINT|COMMIT|ROLLBACK/);
});

test('account deletion hides backend SQL errors from users', () => {
  assert.match(authHandler, /apiError\.status >= 500 \? '注销账户失败，请稍后重试' : apiError\.message/);
});
