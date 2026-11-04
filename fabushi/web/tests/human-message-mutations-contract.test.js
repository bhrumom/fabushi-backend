import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const handler = readFileSync(join(root, 'src/handlers/friends.js'), 'utf8');
const routes = readFileSync(join(root, 'src/routes/community-routes.js'), 'utf8');
const migration = readFileSync(
  join(root, 'migrations/20261031_human_message_mutations.sql'),
  'utf8',
);

test('REG-MSG-MUTATION-STABLE-ID-001: mutation schema preserves canonical rows and monotonic revisions', () => {
  assert.match(migration, /ADD COLUMN revision INTEGER NOT NULL DEFAULT 1/i);
  assert.match(migration, /ADD COLUMN edited_at TEXT/i);
  assert.match(migration, /ADD COLUMN deleted_at TEXT/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS direct_message_mutations/i);
  assert.match(migration, /PRIMARY KEY \(sender_user_id, operation_id\)/i);
  assert.match(migration, /mutation_kind TEXT NOT NULL CHECK \(mutation_kind IN \('edit', 'delete'\)\)/i);
  assert.doesNotMatch(handler, /DELETE FROM direct_messages\s+WHERE id =/i);
});

test('REG-MSG-EDIT-CONFLICT-001: edit is sender-owned, revision-fenced and operation-idempotent', () => {
  assert.match(handler, /handleEditDirectMessage/);
  assert.match(handler, /只能编辑自己发送的消息/);
  assert.match(handler, /expectedRevision/);
  assert.match(handler, /requestDigest/);
  assert.match(handler, /readMessageMutation/);
  assert.match(handler, /SET body = \?, revision = \?, edited_at = \?/);
  assert.match(handler, /WHERE id = \? AND sender_user_id = \? AND revision = \? AND deleted_at IS NULL/);
  assert.match(handler, /消息操作编号已被其他操作使用/);
  assert.match(handler, /消息版本已更新/);
});

test('REG-MSG-DELETE-TOMBSTONE-001: delete keeps message identity while clearing user content and reactions', () => {
  assert.match(handler, /handleDeleteDirectMessage/);
  assert.match(handler, /只能删除自己发送的消息/);
  assert.match(handler, /SET body = '', attachments_json = '\[\]', revision = \?, deleted_at = \?/);
  assert.match(handler, /DELETE FROM direct_message_reactions\s+WHERE message_id = \?/);
  assert.match(handler, /isDeleted: Boolean\(row\.deleted_at\)/);
  assert.match(handler, /deletedAt: row\.deleted_at \?\? null/);
  assert.match(handler, /revision: Number\(row\.revision \?\? 1\)/);
});

test('REG-MSG-MUTATION-ROUTE-001: canonical social message route owns PATCH and DELETE', () => {
  assert.match(routes, /method === 'PATCH'.*handleEditDirectMessage/);
  assert.match(routes, /method === 'DELETE'.*handleDeleteDirectMessage/);
  assert.match(routes, /messages\\\/\(\\d\+\)\$\/\)/);
});

test('REG-MSG-DELETED-REACTION-001: tombstones reject new reactions', () => {
  assert.match(handler, /SELECT id, sender_user_id, recipient_user_id, deleted_at/);
  assert.match(handler, /已删除的消息不能添加表情/);
});

