import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const socialHandler = readFileSync(join(root.pathname, 'src/handlers/social.js'), 'utf8');
const leaderboardHandler = readFileSync(join(root.pathname, 'src/handlers/leaderboard.js'), 'utf8');
const migration = readFileSync(join(root.pathname, 'migrations/20260503_social_follow_privacy.sql'), 'utf8');

test('social follow privacy migration creates required D1 tables and indexes', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_follows/i);
  assert.match(migration, /UNIQUE\(follower_username, following_username\)/i);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_user_follows_follower/i);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_user_follows_following/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_practice_privacy/i);
  assert.match(migration, /show_practice_name INTEGER DEFAULT 1 NOT NULL/i);
  assert.match(migration, /show_duration INTEGER DEFAULT 1 NOT NULL/i);
  assert.match(migration, /show_chant_count INTEGER DEFAULT 1 NOT NULL/i);
});

test('social handler protects follow and privacy endpoints with auth', () => {
  const exportedHandlers = [
    'handleToggleFollow',
    'handleGetFollowList',
    'handleGetFollowSummary',
    'handleGetPracticePrivacy',
    'handleUpdatePracticePrivacy',
  ];

  for (const name of exportedHandlers) {
    assert.match(socialHandler, new RegExp(`export async function ${name}`));
  }

  assert.match(socialHandler, /Authorization/);
  assert.match(socialHandler, /startsWith\('Bearer '\)/);
  assert.match(socialHandler, /verifyToken\(token, env\)/);
  assert.match(socialHandler, /不能关注自己/);
  assert.match(socialHandler, /SELECT username FROM users WHERE username = \?/);
});

test('social handler exposes follow list, summary, toggle, and privacy persistence contracts', () => {
  assert.match(socialHandler, /INSERT INTO user_follows/);
  assert.match(socialHandler, /DELETE FROM user_follows WHERE id = \?/);
  assert.match(socialHandler, /followerCount/);
  assert.match(socialHandler, /followingCount/);
  assert.match(socialHandler, /isFollowing/);
  assert.match(socialHandler, /LIMIT \? OFFSET \?/);
  assert.match(socialHandler, /ON CONFLICT\(username\) DO UPDATE SET/);
  assert.match(socialHandler, /leaderboard:practice:v4/);
});

test('leaderboard handler applies privacy before exposing practice details', () => {
  assert.match(leaderboardHandler, /function applyPracticePrivacy\(entry\)/);
  assert.match(leaderboardHandler, /const canShowDetails = !privacy\.isPrivate/);
  assert.match(leaderboardHandler, /totalRecords: privacy\.isPrivate \? 0/);
  assert.match(leaderboardHandler, /latestSutra: showPracticeName \? entry\.latestSutra \|\| null : null/);
  assert.match(leaderboardHandler, /totalDuration: showDuration \? entry\.totalDuration \|\| 0 : null/);
  assert.match(leaderboardHandler, /totalCount: showChantCount \? entry\.totalCount \|\| 0 : null/);
});

test('public practice records never return notes and respect field-level visibility', () => {
  assert.match(leaderboardHandler, /export async function handleGetLeaderboardRecords/);
  assert.doesNotMatch(leaderboardHandler, /SELECT[^`]*(notes|remark|experience)/i);
  assert.match(leaderboardHandler, /CASE WHEN \? = 1 THEN sutra_name ELSE NULL END as sutra_name/);
  assert.match(leaderboardHandler, /CASE WHEN \? = 1 THEN duration ELSE NULL END as duration/);
  assert.match(leaderboardHandler, /CASE WHEN \? = 1 THEN chant_count ELSE NULL END as chant_count/);
  assert.match(leaderboardHandler, /if \(privacy\.isPrivate\) \{\s*return jsonResponse\(\{ username, privacy, records: \[\] \}\);\s*\}/s);
});

test('leaderboard handler annotates social state for authenticated viewers without caching personal state', () => {
  assert.match(leaderboardHandler, /getOptionalViewerUsername/);
  assert.match(
    leaderboardHandler,
    /EXISTS\([\s\S]*WHERE (?:\w+\.)?follower_username = \? AND (?:\w+\.)?following_username = mr\.username[\s\S]*\) as isFollowing/,
  );
  assert.match(leaderboardHandler, /CASE WHEN mr\.username = \? THEN 1 ELSE 0 END as isSelf/);
  assert.match(leaderboardHandler, /if \(!viewerUsername\) \{/);
  assert.match(leaderboardHandler, /leaderboard:cache:v2/);
  assert.match(leaderboardHandler, /leaderboard:practice:v4/);
});
