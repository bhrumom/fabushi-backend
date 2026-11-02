import assert from 'node:assert/strict';
import test from 'node:test';

import { generateToken } from '../auth-utils.js';
import {
  handleGetDirectMessageResource,
  handleListDirectMessages,
  handleSendDirectMessage,
  handleSetDirectMessageReaction,
  handleUploadDirectMessageResource,
} from '../src/handlers/friends.js';

const ENV = {
  JWT_SECRET: 'human-messaging-contract-secret-at-least-32-bytes-long',
};

const ALICE = {
  id: 1,
  username: 'alice',
  user_no: 101,
  nickname: 'Alice',
  avatar: null,
  alipay_avatar: null,
  wechat_headimgurl: null,
};
const BOB = {
  id: 2,
  username: 'bob',
  user_no: 102,
  nickname: 'Bob',
  avatar: null,
  alipay_avatar: null,
  wechat_headimgurl: null,
};
const CAROL = {
  id: 3,
  username: 'carol',
  user_no: 103,
  nickname: 'Carol',
  avatar: null,
  alipay_avatar: null,
  wechat_headimgurl: null,
};

function normalize(sql) {
  return sql.trim().replace(/\s+/g, ' ');
}

function pairKey(a, b) {
  return [Number(a), Number(b)].sort((x, y) => x - y).join(':');
}

function inPair(row, a, b) {
  return (row.sender_user_id === Number(a) && row.recipient_user_id === Number(b))
    || (row.sender_user_id === Number(b) && row.recipient_user_id === Number(a));
}

function createDb() {
  const users = new Map([ALICE, BOB, CAROL].map((user) => [user.id, { ...user }]));
  const friendships = new Set([pairKey(ALICE.id, BOB.id), pairKey(ALICE.id, CAROL.id)]);
  const resources = new Map();
  const messages = new Map();
  const reactions = [];
  let nextMessageId = 1;

  return {
    state: { resources, messages, reactions },
    prepare(sql) {
      const query = normalize(sql);
      return {
        bind(...params) {
          return {
            async first() {
              if (query.includes('FROM users') && query.includes('WHERE id = ? OR user_no = ?')) {
                const id = Number(params[0]);
                const userNo = Number(params[1]);
                const user = [...users.values()].find(
                  (candidate) => candidate.id === id || candidate.user_no === userNo,
                );
                return user ? { ...user } : null;
              }

              if (query.includes('FROM users') && query.includes('WHERE lower(username) = lower(?)')) {
                const wanted = String(params[0] || '').toLowerCase();
                const user = [...users.values()].find(
                  (candidate) => candidate.username.toLowerCase() === wanted,
                );
                return user ? { ...user } : null;
              }

              if (query.includes('FROM friend_requests') && query.includes("status = 'accepted'")) {
                return friendships.has(pairKey(params[0], params[1])) ? { id: 1 } : null;
              }

              if (query.includes('FROM direct_message_resources')
                  && query.includes('WHERE id = ? AND owner_user_id = ?')) {
                const resource = resources.get(String(params[0]));
                return resource && resource.owner_user_id === Number(params[1])
                  ? { ...resource }
                  : null;
              }

              if (query.includes('FROM direct_message_resources')
                  && query.includes('WHERE id = ?')
                  && !query.includes('owner_user_id = ?')) {
                const resource = resources.get(String(params[0]));
                return resource ? { ...resource } : null;
              }

              if (query.includes('json_each(dm.attachments_json)')) {
                const [resourceId, userId] = params;
                const linked = [...messages.values()].find((row) => {
                  if (row.sender_user_id !== Number(userId)
                      && row.recipient_user_id !== Number(userId)) return false;
                  return JSON.parse(row.attachments_json || '[]')
                    .some((attachment) => attachment.resourceId === resourceId);
                });
                return linked ? { id: linked.id } : null;
              }

              if (query.includes('FROM direct_messages')
                  && query.includes('AND ((sender_user_id = ? AND recipient_user_id = ?)')
                  && query.includes('WHERE id = ?')) {
                const row = messages.get(Number(params[0]));
                return row && inPair(row, params[1], params[2])
                  ? {
                    id: row.id,
                    sender_user_id: row.sender_user_id,
                    recipient_user_id: row.recipient_user_id,
                  }
                  : null;
              }

              if (query.includes('FROM direct_messages')
                  && query.includes('WHERE sender_user_id = ? AND client_request_id = ?')) {
                const row = [...messages.values()].find(
                  (candidate) => candidate.sender_user_id === Number(params[0])
                    && candidate.client_request_id === params[1],
                );
                return row ? { id: row.id } : null;
              }

              if (query.includes('FROM direct_messages')
                  && query.includes('WHERE id = ? AND (sender_user_id = ? OR recipient_user_id = ?)')) {
                const row = messages.get(Number(params[0]));
                return row
                  && (row.sender_user_id === Number(params[1])
                    || row.recipient_user_id === Number(params[2]))
                  ? {
                    id: row.id,
                    sender_user_id: row.sender_user_id,
                    recipient_user_id: row.recipient_user_id,
                    deleted_at: row.deleted_at ?? null,
                  }
                  : null;
              }

              if (query.includes('FROM direct_messages')
                  && query.includes('reply_to_message_id, attachments_json')
                  && query.includes('WHERE id = ?')) {
                const row = messages.get(Number(params[0]));
                return row ? { ...row } : null;
              }

              return null;
            },

            async all() {
              if (query.includes('FROM direct_message_reactions')
                  && query.includes('WHERE message_id IN')) {
                const ids = new Set(params.map(Number));
                return {
                  results: reactions
                    .filter((reaction) => ids.has(reaction.message_id))
                    .map((reaction) => ({ ...reaction })),
                };
              }

              if (query.includes('FROM direct_messages')
                  && query.includes('AND id > ?')
                  && query.includes('ORDER BY id ASC')) {
                const [a, b, , , afterId, q, , limit] = params;
                const needle = String(q || '').toLowerCase();
                return {
                  results: [...messages.values()]
                    .filter((row) => inPair(row, a, b))
                    .filter((row) => row.id > Number(afterId))
                    .filter((row) => !needle || row.body.toLowerCase().includes(needle))
                    .sort((x, y) => x.id - y.id)
                    .slice(0, Number(limit))
                    .map((row) => ({ ...row })),
                };
              }

              if (query.includes('FROM direct_messages')
                  && query.includes('ORDER BY created_at DESC, id DESC')) {
                const [a, b, , , before, , q, , limit] = params;
                const needle = String(q || '').toLowerCase();
                return {
                  results: [...messages.values()]
                    .filter((row) => inPair(row, a, b))
                    .filter((row) => !before || row.created_at < String(before))
                    .filter((row) => !needle || row.body.toLowerCase().includes(needle))
                    .sort((x, y) => {
                      const created = y.created_at.localeCompare(x.created_at);
                      return created || y.id - x.id;
                    })
                    .slice(0, Number(limit))
                    .map((row) => ({ ...row })),
                };
              }

              return { results: [] };
            },

            async run() {
              if (query.startsWith('INSERT INTO direct_message_resources')) {
                const [id, ownerUserId, objectKey, name, contentType, size, createdAt] = params;
                resources.set(String(id), {
                  id: String(id),
                  owner_user_id: Number(ownerUserId),
                  object_key: objectKey,
                  name,
                  content_type: contentType,
                  size: Number(size),
                  created_at: createdAt,
                });
                return { meta: { changes: 1 } };
              }

              if (query.startsWith('INSERT INTO direct_messages')) {
                const [
                  senderUserId,
                  senderUsername,
                  recipientUserId,
                  recipientUsername,
                  body,
                  clientRequestId,
                  createdAt,
                  replyToMessageId,
                  attachmentsJson,
                ] = params;

                if (clientRequestId) {
                  const duplicate = [...messages.values()].find(
                    (row) => row.sender_user_id === Number(senderUserId)
                      && row.client_request_id === clientRequestId,
                  );
                  if (duplicate) return { meta: { changes: 0, last_row_id: 0 } };
                }

                const id = nextMessageId++;
                messages.set(id, {
                  id,
                  sender_user_id: Number(senderUserId),
                  sender_username: senderUsername,
                  recipient_user_id: Number(recipientUserId),
                  recipient_username: recipientUsername,
                  body,
                  client_request_id: clientRequestId,
                  created_at: createdAt,
                  read_at: null,
                  reply_to_message_id: replyToMessageId == null ? null : Number(replyToMessageId),
                  attachments_json: attachmentsJson,
                });
                return { meta: { changes: 1, last_row_id: id } };
              }

              if (query.startsWith('INSERT INTO direct_message_reactions')) {
                const [messageId, userId, emoji, createdAt] = params;
                const target = messages.get(Number(messageId));
                if (!target || target.deleted_at
                    || (target.sender_user_id !== Number(userId)
                      && target.recipient_user_id !== Number(userId))) {
                  return { meta: { changes: 0 } };
                }
                const exists = reactions.some(
                  (reaction) => reaction.message_id === Number(messageId)
                    && reaction.user_id === Number(userId)
                    && reaction.emoji === emoji,
                );
                if (!exists) {
                  reactions.push({
                    message_id: Number(messageId),
                    user_id: Number(userId),
                    emoji,
                    created_at: createdAt,
                  });
                }
                return { meta: { changes: exists ? 0 : 1 } };
              }

              if (query.startsWith('DELETE FROM direct_message_reactions')) {
                const [messageId, userId, emoji] = params;
                const target = messages.get(Number(messageId));
                if (!target || target.deleted_at
                    || (target.sender_user_id !== Number(userId)
                      && target.recipient_user_id !== Number(userId))) {
                  return { meta: { changes: 0 } };
                }
                const index = reactions.findIndex(
                  (reaction) => reaction.message_id === Number(messageId)
                    && reaction.user_id === Number(userId)
                    && reaction.emoji === emoji,
                );
                if (index >= 0) reactions.splice(index, 1);
                return { meta: { changes: index >= 0 ? 1 : 0 } };
              }

              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
}

function createR2() {
  const objects = new Map();
  return {
    objects,
    bucket: {
      async put(key, value) {
        objects.set(key, new Uint8Array(value));
      },
      async get(key) {
        const value = objects.get(key);
        return value ? { body: value } : null;
      },
      async delete(key) {
        objects.delete(key);
      },
    },
  };
}

async function headers(user, deviceId) {
  const token = await generateToken({ id: user.id, username: user.username }, ENV);
  return {
    Authorization: `Bearer ${token}`,
    'x-fabushi-device-id': deviceId,
  };
}

async function post(url, user, deviceId, body) {
  return new Request(url, {
    method: 'POST',
    headers: {
      ...(await headers(user, deviceId)),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function get(url, user, deviceId) {
  return new Request(url, { headers: await headers(user, deviceId) });
}

async function upload(user, deviceId) {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array([7, 8, 9])], { type: 'text/plain' }), 'note.txt');
  return new Request('https://api.example.com/api/social/message-resources', {
    method: 'POST',
    headers: await headers(user, deviceId),
    body: form,
  });
}

test('account identity converges across devices by clientRequestId and afterId', async () => {
  const db = createDb();

  const first = await handleSendDirectMessage(
    await post(
      'https://api.example.com/api/social/messages',
      ALICE,
      'alice-laptop',
      { targetUserId: BOB.id, text: 'hello', clientRequestId: 'alice-nonce-1' },
    ),
    ENV,
    db,
  );
  const firstPayload = await first.json();
  assert.equal(first.status, 201);

  const retry = await handleSendDirectMessage(
    await post(
      'https://api.example.com/api/social/messages',
      ALICE,
      'alice-phone',
      { targetUserId: BOB.id, text: 'hello', clientRequestId: 'alice-nonce-1' },
    ),
    ENV,
    db,
  );
  const retryPayload = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryPayload.deduplicated, true);
  assert.equal(retryPayload.message.id, firstPayload.message.id);
  assert.equal(db.state.messages.size, 1);

  const peer = await handleSendDirectMessage(
    await post(
      'https://api.example.com/api/social/messages',
      BOB,
      'bob-tablet',
      { targetUserId: ALICE.id, text: 'peer update', clientRequestId: 'bob-nonce-1' },
    ),
    ENV,
    db,
  );
  const peerPayload = await peer.json();

  for (const deviceId of ['alice-laptop', 'alice-phone']) {
    const response = await handleListDirectMessages(
      await get(
        `https://api.example.com/api/social/messages?contactId=${BOB.id}&afterId=${firstPayload.message.id}`,
        ALICE,
        deviceId,
      ),
      ENV,
      db,
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.data.messages.map((message) => message.id), [peerPayload.message.id]);
    assert.equal(payload.data.nextAfterId, peerPayload.message.id);
  }
});

test('reply resource reaction and search remain server-canonical and participant scoped', async () => {
  const db = createDb();
  const r2 = createR2();
  const env = { ...ENV, R2_BUCKET: r2.bucket };

  const uploadResponse = await handleUploadDirectMessageResource(
    await upload(ALICE, 'alice-laptop'),
    env,
    db,
  );
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201);
  const resourceId = uploaded.resource.resourceId;

  const baseResponse = await handleSendDirectMessage(
    await post(
      'https://api.example.com/api/social/messages',
      ALICE,
      'alice-laptop',
      { targetUserId: BOB.id, text: 'Dharma Search Target', clientRequestId: 'base-1' },
    ),
    env,
    db,
  );
  const base = await baseResponse.json();

  const replyResponse = await handleSendDirectMessage(
    await post(
      'https://api.example.com/api/social/messages',
      ALICE,
      'alice-phone',
      {
        targetUserId: BOB.id,
        text: '',
        clientRequestId: 'reply-1',
        replyToMessageId: base.message.id,
        attachments: [{ resourceId, name: 'spoof.txt', path: '/tmp/ignored' }],
      },
    ),
    env,
    db,
  );
  const reply = await replyResponse.json();
  assert.equal(replyResponse.status, 201);
  assert.equal(reply.message.replyToMessageId, base.message.id);
  assert.equal(reply.message.attachments[0].name, 'note.txt');
  assert.equal(reply.message.attachments[0].resourceId, resourceId);

  const peerDownload = await handleGetDirectMessageResource(
    await get(
      `https://api.example.com/api/social/message-resources/${resourceId}`,
      BOB,
      'bob-phone',
    ),
    env,
    db,
    resourceId,
  );
  assert.equal(peerDownload.status, 200);
  assert.deepEqual(
    Array.from(new Uint8Array(await peerDownload.arrayBuffer())),
    [7, 8, 9],
  );

  const foreignDownload = await handleGetDirectMessageResource(
    await get(
      `https://api.example.com/api/social/message-resources/${resourceId}`,
      CAROL,
      'carol-phone',
    ),
    env,
    db,
    resourceId,
  );
  assert.equal(foreignDownload.status, 403);

  const messageCount = db.state.messages.size;
  const foreignResource = await handleSendDirectMessage(
    await post(
      'https://api.example.com/api/social/messages',
      BOB,
      'bob-phone',
      {
        targetUserId: ALICE.id,
        text: 'steal resource',
        clientRequestId: 'bad-resource-1',
        attachments: [{ resourceId }],
      },
    ),
    env,
    db,
  );
  assert.equal(foreignResource.status, 403);
  assert.equal(db.state.messages.size, messageCount);

  const foreignReply = await handleSendDirectMessage(
    await post(
      'https://api.example.com/api/social/messages',
      ALICE,
      'alice-laptop',
      {
        targetUserId: CAROL.id,
        text: 'wrong pair',
        clientRequestId: 'bad-reply-1',
        replyToMessageId: base.message.id,
      },
    ),
    env,
    db,
  );
  assert.equal(foreignReply.status, 400);
  assert.equal(db.state.messages.size, messageCount);

  const reactionResponse = await handleSetDirectMessageReaction(
    await post(
      `https://api.example.com/api/social/messages/${base.message.id}/reactions`,
      BOB,
      'bob-phone',
      { emoji: '👍', active: true },
    ),
    env,
    db,
    base.message.id,
  );
  assert.equal(reactionResponse.status, 200);

  const searchResponse = await handleListDirectMessages(
    await get(
      `https://api.example.com/api/social/messages?contactId=${BOB.id}&q=dharma`,
      ALICE,
      'alice-phone',
    ),
    env,
    db,
  );
  const search = await searchResponse.json();
  assert.equal(searchResponse.status, 200);
  assert.equal(search.data.messages.length, 1);
  assert.equal(search.data.messages[0].id, base.message.id);
  assert.deepEqual(search.data.messages[0].reactions, [
    { emoji: '👍', count: 1, reactedByMe: false },
  ]);

  const outsiderReaction = await handleSetDirectMessageReaction(
    await post(
      `https://api.example.com/api/social/messages/${base.message.id}/reactions`,
      CAROL,
      'carol-phone',
      { emoji: '👀', active: true },
    ),
    env,
    db,
    base.message.id,
  );
  assert.equal(outsiderReaction.status, 404);
});

function seedDirectMessage(db, id, sender = ALICE, recipient = BOB, createdAt = '2026-11-02T00:00:00.000Z') {
  db.state.messages.set(id, {
    id,
    sender_user_id: sender.id,
    sender_username: sender.username,
    recipient_user_id: recipient.id,
    recipient_username: recipient.username,
    body: `history-${id}`,
    client_request_id: `history-${id}`,
    created_at: createdAt,
    read_at: null,
    reply_to_message_id: null,
    attachments_json: '[]',
    revision: 1,
    edited_at: null,
    deleted_at: null,
  });
}

test('origin cursor covers equal-timestamp history without crossing participant pairs', async () => {
  const db = createDb();
  for (let id = 1; id <= 450; id += 1) {
    seedDirectMessage(db, id, id % 2 ? ALICE : BOB, id % 2 ? BOB : ALICE);
  }
  seedDirectMessage(db, 451, ALICE, CAROL);
  seedDirectMessage(db, 452, CAROL, ALICE);
  seedDirectMessage(db, 453, BOB, CAROL);

  const seen = [];
  let cursor = 0;
  for (const [pageSize, nextCursor] of [[200, 200], [200, 400], [50, 450], [0, 450]]) {
    const response = await handleListDirectMessages(
      await get(
        `https://api.example.com/api/social/messages?contactId=${BOB.id}&afterId=${cursor}&limit=200`,
        ALICE,
        'history-device',
      ),
      ENV,
      db,
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.contact.id, BOB.id);
    assert.deepEqual(
      payload.data.messages.map((message) => message.id),
      Array.from({ length: pageSize }, (_, index) => cursor + index + 1),
    );
    assert.equal(payload.data.nextAfterId, nextCursor);
    seen.push(...payload.data.messages.map((message) => message.id));
    cursor = payload.data.nextAfterId;
  }
  assert.deepEqual(seen, Array.from({ length: 450 }, (_, index) => index + 1));
  assert.equal(new Set(seen).size, 450);

  // A later ID remains discoverable even when its creation time precedes the
  // entire previous traversal; the cursor is an ID, not a timestamp overlap.
  seedDirectMessage(db, 454, BOB, ALICE, '2026-01-01T00:00:00.000Z');
  const later = await handleListDirectMessages(
    await get(
      `https://api.example.com/api/social/messages?contactId=${BOB.id}&afterId=${cursor}`,
      ALICE,
      'history-device-after-reconnect',
    ),
    ENV,
    db,
  );
  assert.equal(later.status, 200);
  const laterPayload = await later.json();
  assert.deepEqual(laterPayload.data.messages.map((message) => message.id), [454]);
  assert.equal(laterPayload.data.nextAfterId, 454);

  const denied = await handleListDirectMessages(
    await get(
      `https://api.example.com/api/social/messages?contactId=${BOB.id}&afterId=0`,
      CAROL,
      'non-friend-device',
    ),
    ENV,
    db,
  );
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).success, false);
});

test('origin and terminal cursors retain empty progress and bounded page sizes', async () => {
  const db = createDb();
  for (const cursor of [0, Number.MAX_SAFE_INTEGER]) {
    const response = await handleListDirectMessages(
      await get(
        `https://api.example.com/api/social/messages?contactId=${BOB.id}&afterId=${cursor}`,
        ALICE,
        'empty-history-device',
      ),
      ENV,
      db,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.data.messages, []);
    assert.equal(payload.data.nextAfterId, cursor);
  }

  for (let id = 1; id <= 205; id += 1) seedDirectMessage(db, id);
  for (const [limit, expectedSize] of [[null, 50], ['0', 1], ['1', 1], ['200', 200], ['999', 200]]) {
    const url = new URL(`https://api.example.com/api/social/messages?contactId=${BOB.id}&afterId=0`);
    if (limit !== null) url.searchParams.set('limit', limit);
    const response = await handleListDirectMessages(
      await get(url, ALICE, 'bounded-history-device'),
      ENV,
      db,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(
      payload.data.messages.map((message) => message.id),
      Array.from({ length: expectedSize }, (_, index) => index + 1),
    );
    assert.equal(payload.data.nextAfterId, expectedSize);
  }
});

test('malformed and conflicting history cursors fail before reading private messages', async () => {
  const db = createDb();
  seedDirectMessage(db, 1);
  let privateMessageReads = 0;
  const watchedDb = {
    prepare(sql) {
      if (/FROM direct_messages|FROM direct_message_reactions/.test(sql)) privateMessageReads += 1;
      return db.prepare(sql);
    },
  };
  for (const value of [
    '-1', '-0', '1.5', '1.0', '9007199254740992', '9007199254740993',
    'NaN', 'Infinity', '1e2', '0x10', 'invalid', '+1', '1x', '1 2',
  ]) {
    const url = new URL(`https://api.example.com/api/social/messages?contactId=${BOB.id}`);
    url.searchParams.set('afterId', value);
    const response = await handleListDirectMessages(
      await get(url, ALICE, 'invalid-cursor-device'),
      ENV,
      watchedDb,
    );
    assert.equal(response.status, 400, `invalid cursor ${value}`);
    assert.equal((await response.json()).success, false);
  }
  for (const cursor of [0, 1]) {
    const response = await handleListDirectMessages(
      await get(
        `https://api.example.com/api/social/messages?contactId=${BOB.id}&afterId=${cursor}&before=2026-11-02T00:00:00.000Z`,
        ALICE,
        'conflicting-cursor-device',
      ),
      ENV,
      watchedDb,
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
  }
  assert.equal(privateMessageReads, 0);
  assert.equal(db.state.messages.size, 1);
  assert.equal(db.state.messages.get(1).body, 'history-1');
});

test('origin traversal preserves legacy before ordering while separating ID order from clocks', async () => {
  const db = createDb();
  seedDirectMessage(db, 1, ALICE, BOB, '2026-01-02T00:00:00.000Z');
  seedDirectMessage(db, 2, BOB, ALICE, '2026-01-01T00:00:00.000Z');
  seedDirectMessage(db, 3, ALICE, BOB, '2026-01-03T00:00:00.000Z');
  seedDirectMessage(db, 4, ALICE, CAROL, '2026-01-02T00:00:00.000Z');
  for (const [suffix, expectedIds, nextCursor] of [
    ['&limit=2', [1, 3], 3],
    ['&before=2026-01-03T00:00:00.000Z', [2, 1], 1],
    ['&afterId=0', [1, 2, 3], 3],
    ['&afterId=2', [3], 3],
    ['&before=2025-01-01T00:00:00.000Z', [], null],
  ]) {
    const response = await handleListDirectMessages(
      await get(
        `https://api.example.com/api/social/messages?contactId=${BOB.id}${suffix}`,
        ALICE,
        'legacy-history-device',
      ),
      ENV,
      db,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.data.messages.map((message) => message.id), expectedIds, suffix);
    assert.equal(payload.data.nextAfterId, nextCursor, suffix);
  }
});


test('explicit ID history proves requested cursor and preserves legacy response', async () => {
  const db = createDb();
  seedDirectMessage(db, 1, ALICE, BOB);
  seedDirectMessage(db, 2, BOB, ALICE);
  seedDirectMessage(db, 4, ALICE, BOB, '2026-01-01T00:00:00.000Z');
  seedDirectMessage(db, 3, ALICE, CAROL);
  for (const [suffix, requested, ids, next] of [
    ['&afterId=0&limit=2', 0, [1, 2], 2],
    ['&afterId=2', 2, [4], 4],
    ['&afterId=4', 4, [], 4],
    ['&afterId=0&q=nomatch', 0, [], 0],
    ['&afterId=9007199254740991', Number.MAX_SAFE_INTEGER, [], Number.MAX_SAFE_INTEGER],
  ]) {
    const response = await handleListDirectMessages(
      await get('https://api.example.com/api/social/messages?contactId=2' + suffix, ALICE, 'cursor-device'),
      ENV, db,
    );
    assert.equal(response.status, 200, suffix);
    const data = (await response.json()).data;
    assert.deepEqual(data.historyCursor, { mode: 'after-id', afterId: requested }, suffix);
    assert.deepEqual(data.messages.map((message) => message.id), ids, suffix);
    assert.equal(data.nextAfterId, next, suffix);
  }
  for (const suffix of ['&limit=2', '&before=2026-11-03T00:00:00.000Z']) {
    const response = await handleListDirectMessages(
      await get('https://api.example.com/api/social/messages?contactId=2' + suffix, ALICE, 'legacy-device'),
      ENV, db,
    );
    assert.equal(response.status, 200);
    assert.equal(Object.hasOwn((await response.json()).data, 'historyCursor'), false);
  }
  const denied = await handleListDirectMessages(
    await get('https://api.example.com/api/social/messages?contactId=2&afterId=0', CAROL, 'foreign-device'),
    ENV, db,
  );
  assert.equal(denied.status, 403);
  assert.equal(Object.hasOwn(await denied.json(), 'data'), false);
});

