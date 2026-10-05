import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const handler = readFileSync(join(root, 'src/handlers/friends.js'), 'utf8');
const routes = readFileSync(join(root, 'src/routes/community-routes.js'), 'utf8');
const migration = readFileSync(
  join(root, 'migrations/20261005_human_message_extensions.sql'),
  'utf8',
);
const spec = readFileSync(
  join(root, '../../docs/specs/human-direct-messaging-extensions.md'),
  'utf8',
);

test('durable spec preserves one social message truth and device/account separation', () => {
  assert.match(spec, /direct_messages.*canonical durable one-to-one Human message/i);
  assert.match(spec, /x-fabushi-device-id/i);
  assert.match(spec, /Desktop Host Session\/Transcript.*local materialized/i);
  assert.match(spec, /No Telegram\/MTProto provider/i);
});

test('migration adds reply resources and normalized reactions without replacing direct_messages', () => {
  assert.match(migration, /ALTER TABLE direct_messages ADD COLUMN reply_to_message_id/i);
  assert.match(migration, /attachments_json TEXT NOT NULL DEFAULT '\[\]'/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS direct_message_resources/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS direct_message_reactions/i);
  assert.match(migration, /PRIMARY KEY \(message_id, user_id, emoji\)/i);
  assert.match(migration, /idx_direct_messages_pair_id/i);
});

test('message send validates canonical resources and same-pair reply before persistence', () => {
  assert.match(handler, /canonicalizeMessageResources\(db, auth\.userId, body\.attachments\)/);
  assert.match(handler, /requirePairMessage\(db, body\.replyToMessageId, auth\.userId, target\.id\)/);
  assert.match(handler, /回复目标不属于当前会话/);
  assert.match(handler, /消息附件不存在或不属于当前账号/);
  assert.match(handler, /status = message === '消息附件不存在或不属于当前账号' \? 403 : 400/);
  assert.match(handler, /ON CONFLICT\(sender_user_id, client_request_id\).*DO NOTHING/s);
  assert.match(handler, /reply_to_message_id, attachments_json/);
});

test('message resource upload and read are account authorized and R2 backed', () => {
  assert.match(handler, /handleUploadDirectMessageResource/);
  assert.match(handler, /MAX_MESSAGE_RESOURCE_BYTES = 25 \* 1024 \* 1024/);
  assert.match(handler, /private\/message-resources\/\$\{auth\.userId\}/);
  assert.match(handler, /R2_BUCKET\.put/);
  assert.match(handler, /json_each\(dm\.attachments_json\)/);
  assert.match(handler, /dm\.sender_user_id = \? OR dm\.recipient_user_id = \?/);
  assert.match(handler, /R2_BUCKET\.get/);
  assert.doesNotMatch(handler, /objectKey[^\n]*resource:/);
});

test('reconnect search and reactions stay scoped to the authenticated peer pair', () => {
  assert.match(handler, /afterId/);
  assert.match(handler, /id > \?/);
  assert.match(handler, /lower\(body\) LIKE lower\(\?\)/);
  assert.match(handler, /handleSetDirectMessageReaction/);
  assert.match(handler, /sender_user_id = \? OR recipient_user_id = \?/);
  assert.match(handler, /ON CONFLICT\(message_id, user_id, emoji\) DO NOTHING/);
  assert.match(handler, /DELETE FROM direct_message_reactions/);
});

test('community router exposes only explicit Human message extension endpoints', () => {
  assert.ok(routes.includes('/api/social/message-resources'));
  assert.match(routes, /message-resources\\\/\(\[0-9a-f-\]\{36\}\)/);
  assert.match(routes, /messages\\\/\(\\d\+\)\\\/reactions/);
  assert.ok(routes.includes('/api/social/messages'));
});
