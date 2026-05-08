import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const webRoot = new URL('..', import.meta.url);

const authHandler = readFileSync(join(webRoot.pathname, 'src/handlers/auth.js'), 'utf8');
const deleteAccountUseCase = readFileSync(join(webRoot.pathname, 'src/use-cases/delete-account.js'), 'utf8');
const accountCommandRepository = readFileSync(
  join(webRoot.pathname, 'src/repositories/account-user-command-repository.js'),
  'utf8'
);
const leaderboardHandler = readFileSync(join(webRoot.pathname, 'src/handlers/leaderboard.js'), 'utf8');

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
  assert.match(accountCommandRepository, /DELETE FROM meditation_records WHERE username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM meditation_goals WHERE username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM meditation_settings WHERE username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM user_practice_privacy WHERE username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM meditation_groups WHERE owner_username = \?/);
  assert.match(accountCommandRepository, /DELETE FROM meditation_group_members WHERE group_id IN \(SELECT id FROM meditation_groups WHERE owner_username = \?\)/);
  assert.match(accountCommandRepository, /DELETE FROM user_follows WHERE follower_username = \? OR following_username = \?/);
});
