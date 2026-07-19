import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const handler = readFileSync(join(root, 'src/handlers/friends.js'), 'utf8');
const router = readFileSync(join(root, 'src/router.js'), 'utf8');
const webRuntimeBootstrap = readFileSync(
  join(root, 'mahayana-wasm/bootstrap.js'),
  'utf8',
);
const webRuntimeBridge = readFileSync(
  join(root, '../lib/services/miniapp/mahayana_codex_runtime_web.dart'),
  'utf8',
);
const migration = readFileSync(
  join(root, 'migrations/20260713_friends_and_direct_messages.sql'),
  'utf8',
);

test('friend and direct-message storage has durable identities and indexes', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS friend_requests/i);
  assert.match(migration, /sender_user_id INTEGER NOT NULL/i);
  assert.match(migration, /recipient_user_id INTEGER NOT NULL/i);
  assert.match(migration, /CHECK \(status IN \('pending', 'accepted', 'rejected', 'cancelled'\)\)/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS direct_messages/i);
  assert.match(migration, /idx_direct_messages_client_request/i);
});

test('friend handlers require stable authenticated account identities', () => {
  assert.match(handler, /requireAuthIdentity\(request, env, db\)/);
  assert.match(handler, /Number\.isFinite\(auth\.userId\)/);
  assert.match(handler, /只能给已添加的好友发送消息/);
  assert.match(handler, /MAX_MESSAGE_LENGTH = 4000/);
  assert.match(handler, /clientRequestId\.length > 200/);
  assert.match(handler, /SELECT id, sender_user_id, recipient_user_id, body/);
  assert.match(handler, /deduplicated \? 200 : 201/);
});

test('router exposes the endpoints already consumed by Flutter and the CLI', () => {
  for (const path of [
    '/api/social/users/search',
    '/api/social/friends',
    '/api/social/friend-requests',
    '/api/social/friend-requests/incoming',
    '/api/social/messages',
  ]) {
    assert.ok(router.includes(path), `missing ${path}`);
  }
  assert.match(router, /friend-requests\\\/\(\\d\+\)\\\/accept/);
});

test('browser embeds the WASM runtime without a cloud Agent gateway', () => {
  assert.ok(!router.includes('/api/mahayana/execute'));
  assert.match(webRuntimeBootstrap, /new Worker/);
  assert.match(webRuntimeBootstrap, /createRuntime/);
  assert.match(webRuntimeBootstrap, /receive/);
  assert.match(
    readFileSync(join(root, 'mahayana-wasm/worker.js'), 'utf8'),
    /getDirectoryHandle/,
  );
  assert.match(webRuntimeBridge, /mahayanaWasm\.execute/);
  assert.ok(!webRuntimeBridge.includes('/api/mahayana/execute'));
  assert.match(webRuntimeBridge, /mahayanaWasm\.executeProduct/);
  assert.match(webRuntimeBridge, /executeProduct\(request\)/);
});
