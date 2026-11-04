import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { generateToken } from '../auth-utils.js';
import {
  handleDeleteDirectMessage,
  handleEditDirectMessage,
  handleListDirectMessages,
  handleSetDirectMessageReaction,
} from '../src/handlers/friends.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = { JWT_SECRET: 'sqlite-message-contract-only-secret-at-least-32-bytes' };
const LEGACY_ID = 17;
const NAMES = { 1: 'alice', 2: 'bob', 3: 'carol' };

function migration(name) {
  return readFileSync(join(ROOT, 'migrations', name), 'utf8');
}

// Execute the production handler's SQL in the real SQLite engine. This adapter
// implements the D1 binding surface only; it is not a deployed-D1 acceptance
// claim. D1 documents batch as one transaction with full rollback on failure.
function binding(database, hooks) {
  function statement(sql, params = []) {
    const run = () => {
      const result = database().prepare(sql).run(...params);
      return {
        success: true,
        results: [],
        meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
      };
    };
    return {
      bind(...values) { return statement(sql, values); },
      async first(column) {
        const row = database().prepare(sql).get(...params);
        if (!row) return null;
        return column ? row[column] : { ...row };
      },
      async all() {
        return {
          success: true,
          results: database().prepare(sql).all(...params).map((row) => ({ ...row })),
          meta: { changes: 0 },
        };
      },
      async run() {
        await hooks.beforeRun?.(sql, params);
        return run();
      },
      executeInBatch: run,
    };
  }
  return {
    prepare: statement,
    async batch(statements) {
      await hooks.beforeBatch?.();
      database().exec('BEGIN IMMEDIATE');
      let results;
      try {
        results = statements.map((entry) => entry.executeInBatch());
        database().exec('COMMIT');
      } catch (error) {
        database().exec('ROLLBACK');
        throw error;
      }
      // A transport can lose the reply after the durable transaction committed.
      await hooks.afterBatch?.();
      return results;
    },
  };
}

function fixture(t, { legacy = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'human-mutation-sqlite-'));
  const path = join(directory, 'messages.sqlite');
  let sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, user_no INTEGER,
      nickname TEXT, avatar TEXT, alipay_avatar TEXT, wechat_headimgurl TEXT
    );
    INSERT INTO users(id,username,user_no) VALUES (1,'alice',101),(2,'bob',102),(3,'carol',103);
  `);
  sqlite.exec(migration('20260713_friends_and_direct_messages.sql'));
  sqlite.exec(`
    INSERT INTO friend_requests(sender_user_id,sender_username,recipient_user_id,
      recipient_username,status,created_at,updated_at)
      VALUES (1,'alice',2,'bob','accepted','2026-01-01','2026-01-01');
  `);
  if (legacy) {
    sqlite.exec(`
      INSERT INTO direct_messages(id,sender_user_id,sender_username,recipient_user_id,
        recipient_username,body,client_request_id,created_at,read_at)
        VALUES (17,1,'alice',2,'bob','original','legacy-nonce','2026-01-01','2026-01-02');
    `);
  }
  sqlite.exec(migration('20261005_human_message_extensions.sql'));
  if (legacy) {
    sqlite.exec(`
      INSERT INTO direct_message_resources(id,owner_user_id,object_key,name,content_type,size)
        VALUES ('resource-17',1,'private-key','old.txt','text/plain',3);
      UPDATE direct_messages SET attachments_json='[{"resourceId":"resource-17","name":"old.txt"}]'
        WHERE id=17;
    `);
  }
  sqlite.exec(migration('20261031_human_message_mutations.sql'));
  const hooks = {};
  const db = binding(() => sqlite, hooks);
  t.after(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    db, hooks,
    get sqlite() { return sqlite; },
    reopen() {
      sqlite.close();
      sqlite = new DatabaseSync(path);
      sqlite.exec('PRAGMA foreign_keys=ON');
    },
    message(id = LEGACY_ID) {
      const row = sqlite.prepare('SELECT * FROM direct_messages WHERE id=?').get(id);
      return row ? { ...row } : null;
    },
    count(table) { return sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count; },
    react(userId = 2) {
      sqlite.prepare(`INSERT INTO direct_message_reactions(message_id,user_id,emoji,created_at)
        VALUES (?,?,?,'2026-01-03')`).run(LEGACY_ID, userId, '👍');
    },
  };
}

async function request(method, body, userId = 1, query = '') {
  const token = await generateToken({ id: userId, username: NAMES[userId] }, ENV);
  return new Request(`https://api.example.test/api/social/messages${query}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function remove(f, operationId = 'delete-17', expectedRevision = 1, userId = 1) {
  return handleDeleteDirectMessage(
    await request('DELETE', { operationId, expectedRevision }, userId), ENV, f.db, LEGACY_ID,
  );
}

async function edit(f, operationId, text, expectedRevision = 1, userId = 1) {
  return handleEditDirectMessage(
    await request('PATCH', { operationId, text, expectedRevision }, userId), ENV, f.db, LEGACY_ID,
  );
}

async function reaction(f, active, userId = 2) {
  return handleSetDirectMessageReaction(
    await request('POST', { emoji: '👍', active }, userId), ENV, f.db, LEGACY_ID,
  );
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function assertTombstone(f) {
  const row = f.message();
  assert.equal(row.id, LEGACY_ID);
  assert.equal(row.revision, 2);
  assert.equal(row.body, '');
  assert.equal(row.attachments_json, '[]');
  assert.ok(row.deleted_at);
  assert.equal(row.client_request_id, 'legacy-nonce');
  assert.equal(row.created_at, '2026-01-01');
  assert.equal(row.read_at, '2026-01-02');
  assert.equal(f.count('direct_message_reactions'), 0);
  assert.equal(f.count('direct_message_mutations'), 1);
  assert.equal(f.count('direct_message_resources'), 1);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
}

test('SQLite migration preserves existing message, resource and identity after reopen', (t) => {
  const f = fixture(t);
  const before = f.message();
  f.reopen();
  assert.deepEqual(f.message(), before);
  assert.equal(before.id, LEGACY_ID);
  assert.equal(before.body, 'original');
  assert.equal(before.revision, 1);
  assert.equal(before.deleted_at, null);
  assert.equal(before.edited_at, null);
  assert.equal(before.client_request_id, 'legacy-nonce');
  assert.equal(before.read_at, '2026-01-02');
  assert.deepEqual(JSON.parse(before.attachments_json), [{ resourceId: 'resource-17', name: 'old.txt' }]);
  assert.equal(f.count('direct_message_resources'), 1);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => f.sqlite.exec(`INSERT INTO direct_message_reactions(message_id,user_id,emoji)
    VALUES (999,2,'👍')`), /FOREIGN KEY/);
});

test('SQLite reaction cleanup failure rolls back the complete delete and retries after reopen', async (t) => {
  const f = fixture(t);
  f.react();
  f.sqlite.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON direct_message_reactions
    BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END;`);
  await assert.rejects(remove(f), /injected cleanup failure/);
  f.reopen();
  assert.equal(f.message().body, 'original');
  assert.equal(f.message().revision, 1);
  assert.equal(f.message().deleted_at, null);
  assert.equal(f.count('direct_message_mutations'), 0);
  assert.equal(f.count('direct_message_reactions'), 1);
  f.sqlite.exec('DROP TRIGGER fail_cleanup');
  assert.equal((await remove(f)).status, 200);
  assertTombstone(f);
  const replay = await remove(f);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).deduplicated, true);
  assertTombstone(f);
});

test('SQLite lost delete acknowledgement recovers by operation ID after reopen', async (t) => {
  const f = fixture(t);
  f.react();
  f.hooks.afterBatch = () => { throw new Error('injected lost batch acknowledgement'); };
  await assert.rejects(remove(f), /lost batch acknowledgement/);
  f.hooks.afterBatch = undefined;
  f.reopen();
  assertTombstone(f);
  const response = await remove(f);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.deduplicated, true);
  assert.equal(result.message.id, LEGACY_ID);
  assert.equal(result.message.isDeleted, true);
  assert.deepEqual(result.message.reactions, []);
  assertTombstone(f);
});

test('SQLite replay repairs an old partial tombstone and does not swallow cleanup failure', async (t) => {
  const f = fixture(t);
  assert.equal((await remove(f)).status, 200);
  // Recreate the state that the older separate post-commit cleanup could leave.
  f.react();
  f.sqlite.exec(`CREATE TRIGGER fail_repair BEFORE DELETE ON direct_message_reactions
    BEGIN SELECT RAISE(ABORT,'injected repair failure'); END;`);
  f.reopen();
  await assert.rejects(remove(f), /injected repair failure/);
  assert.equal(f.count('direct_message_mutations'), 1);
  assert.equal(f.count('direct_message_reactions'), 1);
  f.sqlite.exec('DROP TRIGGER fail_repair');
  f.reopen();
  const response = await remove(f);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deduplicated, true);
  assertTombstone(f);
});

async function raceReactionAgainstDelete(t, active) {
  const f = fixture(t);
  if (!active) f.react();
  const reached = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let paused = false;
  f.hooks.beforeRun = async (sql) => {
    const operation = active ? /^\s*INSERT INTO direct_message_reactions/ : /^\s*DELETE FROM direct_message_reactions/;
    if (!paused && operation.test(sql)) {
      paused = true;
      reached.resolve();
      await release.promise;
    }
  };
  const pending = reaction(f, active);
  await reached.promise;
  const deletion = await remove(f);
  assert.equal(deletion.status, 200);
  release.resolve();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).success, false);
  assertTombstone(f);
}

test('SQLite delayed reaction insert cannot resurrect a concurrently deleted message', { timeout: 10000 }, async (t) => {
  await raceReactionAgainstDelete(t, true);
});

test('SQLite delayed reaction removal cannot acknowledge a concurrently deleted message', { timeout: 10000 }, async (t) => {
  await raceReactionAgainstDelete(t, false);
});

test('SQLite live reaction retries remain idempotent and unauthorized actors remain denied', async (t) => {
  const f = fixture(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await reaction(f, true);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).reactions, [{ emoji: '👍', count: 1, reactedByMe: true }]);
  }
  assert.equal(f.count('direct_message_reactions'), 1);
  assert.equal((await reaction(f, true, 3)).status, 404);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await reaction(f, false);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).reactions, []);
  }
  assert.equal((await remove(f)).status, 200);
  assert.equal((await reaction(f, true)).status, 409);
  assert.equal((await reaction(f, false)).status, 409);
  assertTombstone(f);
});

test('SQLite edit replay, revision conflict and owner checks execute actual handlers', async (t) => {
  const f = fixture(t);
  assert.equal((await edit(f, 'foreign', 'changed', 1, 2)).status, 403);
  assert.equal((await edit(f, 'foreign', 'changed', 1, 3)).status, 404);
  assert.equal((await remove(f, 'foreign', 1, 2)).status, 403);
  assert.equal((await remove(f, 'foreign', 1, 3)).status, 404);
  const edited = await edit(f, 'edit-17', 'new body');
  const result = await edited.json();
  assert.equal(edited.status, 200);
  assert.equal(result.message.id, LEGACY_ID);
  assert.equal(result.message.revision, 2);
  assert.equal(result.message.text, 'new body');
  assert.equal(result.message.clientRequestId, 'legacy-nonce');
  f.reopen();
  const replay = await edit(f, 'edit-17', 'new body');
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).deduplicated, true);
  assert.equal((await edit(f, 'edit-17', 'different payload')).status, 409);
  assert.equal((await edit(f, 'stale-edit', 'stale body')).status, 409);
  assert.equal(f.message().body, 'new body');
  assert.equal(f.message().revision, 2);
  assert.equal(f.count('direct_messages'), 1);
  assert.equal(f.count('direct_message_mutations'), 1);
});

test('SQLite concurrent edits at one revision have one durable winner', { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const reached = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let arrivals = 0;
  f.hooks.beforeBatch = async () => {
    arrivals += 1;
    if (arrivals === 2) reached.resolve();
    await release.promise;
  };
  const first = edit(f, 'edit-a', 'winner a');
  const second = edit(f, 'edit-b', 'winner b');
  await reached.promise;
  release.resolve();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(f.message().revision, 2);
  assert.ok(['winner a', 'winner b'].includes(f.message().body));
  assert.equal(f.count('direct_message_mutations'), 1);
  f.reopen();
  assert.equal(f.message().revision, 2);
  assert.equal(f.count('direct_message_mutations'), 1);
});

test('SQLite afterId zero paginates real rows, retains empty cursors and scopes authorized pairs', async (t) => {
  const f = fixture(t, { legacy: false });
  const insert = f.sqlite.prepare(`INSERT INTO direct_messages(id,sender_user_id,sender_username,
    recipient_user_id,recipient_username,body,created_at) VALUES (?,1,'alice',2,'bob',?,'2026-01-01')`);
  for (let index = 1; index <= 450; index += 1) insert.run(index * 2, `message ${index}`);
  f.sqlite.exec(`INSERT INTO direct_messages(id,sender_user_id,sender_username,
    recipient_user_id,recipient_username,body,created_at) VALUES (999,2,'bob',3,'carol','private','2026-01-01')`);
  const seen = [];
  let cursor = 0;
  for (const size of [200, 200, 50, 0]) {
    const response = await handleListDirectMessages(
      await request('GET', undefined, 1, `?contactId=2&afterId=${cursor}&limit=200`), ENV, f.db,
    );
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.data.historyCursor, { mode: 'after-id', afterId: cursor });
    assert.equal(result.data.messages.length, size);
    seen.push(...result.data.messages.map((message) => message.id));
    const next = size ? result.data.messages.at(-1).id : cursor;
    assert.equal(result.data.nextAfterId, next);
    cursor = next;
    f.reopen();
  }
  assert.deepEqual(seen, Array.from({ length: 450 }, (_, index) => (index + 1) * 2));
  assert.equal(new Set(seen).size, 450);
  assert.equal(cursor, 900);
  const forbidden = await handleListDirectMessages(
    await request('GET', undefined, 1, '?contactId=3&afterId=0'), ENV, f.db,
  );
  assert.equal(forbidden.status, 403);
  const unauthenticated = await handleListDirectMessages(
    new Request('https://api.example.test/api/social/messages?contactId=2&afterId=0'), ENV, f.db,
  );
  assert.equal(unauthenticated.status, 401);
  for (const value of ['-1', '1.5', '0x10', '9007199254740992']) {
    const response = await handleListDirectMessages(
      await request('GET', undefined, 1, `?contactId=2&afterId=${value}`), ENV, f.db,
    );
    assert.equal(response.status, 400);
  }
  const legacy = await handleListDirectMessages(
    await request('GET', undefined, 1, '?contactId=2&limit=1'), ENV, f.db,
  );
  assert.equal(legacy.status, 200);
  assert.equal('historyCursor' in (await legacy.json()).data, false);
});

test('SQLite edit/delete reject malformed JSON with 400 and accept body-less DELETE query parameters', async (t) => {
  const f = fixture(t);
  const token = await generateToken({ id: 1, username: NAMES[1] }, ENV);
  const raw = (method, body, query = '') => new Request(`https://api.example.test/api/social/messages/${LEGACY_ID}${query}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });
  const before = f.message();
  for (const body of ['{not json', '[1,2]', 'null', '"text"']) {
    const editResponse = await handleEditDirectMessage(raw('PATCH', body), ENV, f.db, LEGACY_ID);
    assert.equal(editResponse.status, 400, `edit ${body}`);
    const deleteResponse = await handleDeleteDirectMessage(raw('DELETE', body), ENV, f.db, LEGACY_ID);
    assert.equal(deleteResponse.status, 400, `delete ${body}`);
  }
  assert.deepEqual(f.message(), before);
  assert.equal(f.count('direct_message_mutations'), 0);

  const missing = await handleDeleteDirectMessage(raw('DELETE'), ENV, f.db, LEGACY_ID);
  assert.equal(missing.status, 400);
  assert.deepEqual(f.message(), before);

  const deleted = await handleDeleteDirectMessage(
    raw('DELETE', undefined, '?operationId=delete-query-17&expectedRevision=1'), ENV, f.db, LEGACY_ID,
  );
  assert.equal(deleted.status, 200);
  assert.equal(f.message().revision, 2);
  assert.ok(f.message().deleted_at);
});
