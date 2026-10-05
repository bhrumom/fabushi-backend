import { jsonResponse } from '../utils/response.js';
import { requireAuthIdentity } from '../utils/auth-identity.js';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_MESSAGE_ATTACHMENTS = 10;
const MAX_MESSAGE_RESOURCE_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGE_SEARCH_LENGTH = 200;

async function requireStableAuth(request, env, db) {
  const auth = await requireAuthIdentity(request, env, db);
  if (auth.error) return auth;
  if (!Number.isFinite(auth.userId)) {
    return { error: '账号资料需要刷新后才能使用好友功能', status: 409 };
  }
  return auth;
}

function mapContact(row, status = 'friend') {
  return {
    id: row.id,
    userId: row.id,
    username: row.username,
    userNo: row.user_no ?? null,
    displayName: row.nickname || row.username,
    nickname: row.nickname || null,
    avatarUrl:
      row.avatar || row.alipay_avatar || row.wechat_headimgurl || null,
    status,
  };
}

function clampLimit(value, fallback = 50, maximum = 100) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), maximum);
}

async function findUser(db, identifier) {
  const value = String(identifier ?? '').trim();
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const byId = await db.prepare(`
      SELECT id, username, user_no, nickname, avatar, alipay_avatar, wechat_headimgurl
      FROM users
      WHERE id = ? OR user_no = ?
      LIMIT 1
    `).bind(numeric, numeric).first();
    if (byId) return byId;
  }
  return await db.prepare(`
    SELECT id, username, user_no, nickname, avatar, alipay_avatar, wechat_headimgurl
    FROM users
    WHERE lower(username) = lower(?)
    LIMIT 1
  `).bind(value).first();
}

async function areFriends(db, firstUserId, secondUserId) {
  const row = await db.prepare(`
    SELECT id
    FROM friend_requests
    WHERE status = 'accepted'
      AND ((sender_user_id = ? AND recipient_user_id = ?)
        OR (sender_user_id = ? AND recipient_user_id = ?))
    LIMIT 1
  `).bind(firstUserId, secondUserId, secondUserId, firstUserId).first();
  return Boolean(row);
}

export async function handleSearchFriendUsers(request, env, db) {
  const auth = await requireStableAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) return jsonResponse({ success: true, data: { users: [] } });
  const limit = clampLimit(url.searchParams.get('limit'), 20, 50);
  const like = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const numeric = Number(query);

  const rows = await db.prepare(`
    SELECT
      u.id, u.username, u.user_no, u.nickname, u.avatar,
      u.alipay_avatar, u.wechat_headimgurl,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM friend_requests f
          WHERE f.status = 'accepted'
            AND ((f.sender_user_id = ? AND f.recipient_user_id = u.id)
              OR (f.sender_user_id = u.id AND f.recipient_user_id = ?))
        ) THEN 'friend'
        WHEN EXISTS (
          SELECT 1 FROM friend_requests f
          WHERE f.status = 'pending'
            AND f.sender_user_id = ? AND f.recipient_user_id = u.id
        ) THEN 'pending'
        ELSE 'available'
      END AS relationship_status
    FROM users u
    WHERE u.id != ?
      AND (
        lower(u.username) LIKE lower(?) ESCAPE '\\'
        OR lower(COALESCE(u.nickname, '')) LIKE lower(?) ESCAPE '\\'
        OR (? IS NOT NULL AND (u.id = ? OR u.user_no = ?))
      )
    ORDER BY
      CASE WHEN lower(u.username) = lower(?) THEN 0 ELSE 1 END,
      u.username ASC
    LIMIT ?
  `).bind(
    auth.userId, auth.userId, auth.userId, auth.userId,
    like, like,
    Number.isFinite(numeric) ? numeric : null,
    Number.isFinite(numeric) ? numeric : null,
    Number.isFinite(numeric) ? numeric : null,
    query, limit,
  ).all();

  return jsonResponse({
    success: true,
    data: {
      users: (rows.results || []).map((row) =>
        mapContact(row, row.relationship_status || 'available')),
    },
  });
}

export async function handleListFriends(request, env, db) {
  const auth = await requireStableAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  const rows = await db.prepare(`
    SELECT DISTINCT
      u.id, u.username, u.user_no, u.nickname, u.avatar,
      u.alipay_avatar, u.wechat_headimgurl,
      f.updated_at AS friendship_updated_at
    FROM friend_requests f
    JOIN users u ON u.id = CASE
      WHEN f.sender_user_id = ? THEN f.recipient_user_id
      ELSE f.sender_user_id
    END
    WHERE f.status = 'accepted'
      AND (f.sender_user_id = ? OR f.recipient_user_id = ?)
    ORDER BY f.updated_at DESC
  `).bind(auth.userId, auth.userId, auth.userId).all();

  return jsonResponse({
    success: true,
    data: { friends: (rows.results || []).map((row) => mapContact(row)) },
  });
}

export async function handleCreateFriendRequest(request, env, db) {
  const auth = await requireStableAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  const body = await request.json();
  const target = await findUser(
    db,
    body.targetUserId ?? body.targetUsername ?? body.username,
  );
  if (!target) return jsonResponse({ success: false, error: '未找到联系人' }, 404);
  if (target.id === auth.userId) {
    return jsonResponse({ success: false, error: '不能添加自己为好友' }, 400);
  }
  if (await areFriends(db, auth.userId, target.id)) {
    return jsonResponse({ success: true, alreadyFriends: true, user: mapContact(target) });
  }

  const reverse = await db.prepare(`
    SELECT id FROM friend_requests
    WHERE status = 'pending' AND sender_user_id = ? AND recipient_user_id = ?
    LIMIT 1
  `).bind(target.id, auth.userId).first();
  if (reverse) {
    return jsonResponse({
      success: false,
      error: '对方已经向你发送好友申请，请先接受该申请',
      incomingRequestId: reverse.id,
    }, 409);
  }

  const message = String(body.message || '').trim().slice(0, 300);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO friend_requests (
      sender_user_id, sender_username, recipient_user_id,
      recipient_username, message, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(sender_user_id, recipient_user_id) WHERE status = 'pending'
    DO UPDATE SET message = excluded.message, updated_at = excluded.updated_at
  `).bind(
    auth.userId, auth.username, target.id, target.username, message, now, now,
  ).run();

  return jsonResponse({ success: true, status: 'pending', user: mapContact(target, 'pending') }, 201);
}

export async function handleListIncomingFriendRequests(request, env, db) {
  const auth = await requireStableAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);

  const rows = await db.prepare(`
    SELECT
      f.id AS request_id, f.message, f.created_at,
      u.id, u.username, u.user_no, u.nickname, u.avatar,
      u.alipay_avatar, u.wechat_headimgurl
    FROM friend_requests f
    JOIN users u ON u.id = f.sender_user_id
    WHERE f.recipient_user_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).bind(auth.userId).all();

  return jsonResponse({
    success: true,
    data: {
      requests: (rows.results || []).map((row) => ({
        id: row.request_id,
        requestId: row.request_id,
        message: row.message || '',
        createdAt: row.created_at,
        fromUser: mapContact(row, 'pending'),
      })),
    },
  });
}

export async function handleAcceptFriendRequest(request, env, db, requestId) {
  const auth = await requireStableAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const id = Number(requestId);
  if (!Number.isFinite(id)) {
    return jsonResponse({ success: false, error: '好友申请编号无效' }, 400);
  }

  const pending = await db.prepare(`
    SELECT id, sender_user_id
    FROM friend_requests
    WHERE id = ? AND recipient_user_id = ? AND status = 'pending'
    LIMIT 1
  `).bind(id, auth.userId).first();
  if (!pending) return jsonResponse({ success: false, error: '好友申请不存在或已处理' }, 404);

  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE friend_requests SET status = 'accepted', updated_at = ?
    WHERE id = ? AND recipient_user_id = ? AND status = 'pending'
  `).bind(now, id, auth.userId).run();
  return jsonResponse({ success: true, requestId: id, status: 'accepted' });
}


function valueId(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function parseAttachmentsJson(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function requirePairMessage(db, messageId, firstUserId, secondUserId) {
  const id = Number(messageId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return await db.prepare(`
    SELECT id, sender_user_id, recipient_user_id
    FROM direct_messages
    WHERE id = ?
      AND ((sender_user_id = ? AND recipient_user_id = ?)
        OR (sender_user_id = ? AND recipient_user_id = ?))
    LIMIT 1
  `).bind(id, firstUserId, secondUserId, secondUserId, firstUserId).first();
}

async function canonicalizeMessageResources(db, ownerUserId, requested) {
  if (requested == null) return [];
  if (!Array.isArray(requested)) throw new Error('消息附件格式无效');
  if (requested.length > MAX_MESSAGE_ATTACHMENTS) throw new Error(`消息附件不能超过 ${MAX_MESSAGE_ATTACHMENTS} 个`);
  const canonical = [];
  const seen = new Set();
  for (const item of requested) {
    const resourceId = String(item?.resourceId ?? item?.id ?? '').trim();
    if (!resourceId || seen.has(resourceId)) continue;
    seen.add(resourceId);
    const row = await db.prepare(`
      SELECT id, name, content_type, size, created_at
      FROM direct_message_resources
      WHERE id = ? AND owner_user_id = ?
      LIMIT 1
    `).bind(resourceId, ownerUserId).first();
    if (!row) throw new Error('消息附件不存在或不属于当前账号');
    canonical.push({
      resourceId: row.id,
      name: row.name,
      contentType: row.content_type,
      size: row.size,
      createdAt: row.created_at,
    });
  }
  return canonical;
}

async function loadReactionMap(db, messageIds, authUserId) {
  const ids = [...new Set(messageIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const map = new Map();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.prepare(`
    SELECT message_id, user_id, emoji, created_at
    FROM direct_message_reactions
    WHERE message_id IN (${placeholders})
    ORDER BY message_id ASC, created_at ASC, user_id ASC
  `).bind(...ids).all();
  for (const row of rows.results || []) {
    let message = map.get(row.message_id);
    if (!message) {
      message = new Map();
      map.set(row.message_id, message);
    }
    let reaction = message.get(row.emoji);
    if (!reaction) {
      reaction = { emoji: row.emoji, count: 0, reactedByMe: false };
      message.set(row.emoji, reaction);
    }
    reaction.count += 1;
    if (row.user_id === authUserId) reaction.reactedByMe = true;
  }
  return new Map([...map].map(([messageId, reactions]) => [messageId, [...reactions.values()]]));
}

function mapDirectMessage(row, authUserId, reactionMap = new Map()) {
  return {
    id: row.id,
    senderUserId: row.sender_user_id,
    senderUsername: row.sender_username ?? null,
    recipientUserId: row.recipient_user_id,
    recipientUsername: row.recipient_username ?? null,
    text: row.body,
    clientRequestId: row.client_request_id ?? null,
    createdAt: row.created_at,
    readAt: row.read_at ?? null,
    isOutgoing: row.sender_user_id === authUserId,
    replyToMessageId: row.reply_to_message_id ?? null,
    attachments: parseAttachmentsJson(row.attachments_json),
    reactions: reactionMap.get(row.id) || [],
  };
}

async function readCanonicalDirectMessage(db, messageId, authUserId) {
  const row = await db.prepare(`
    SELECT id, sender_user_id, sender_username, recipient_user_id,
      recipient_username, body, client_request_id, created_at, read_at,
      reply_to_message_id, attachments_json
    FROM direct_messages
    WHERE id = ?
    LIMIT 1
  `).bind(messageId).first();
  if (!row) return null;
  const reactions = await loadReactionMap(db, [row.id], authUserId);
  return mapDirectMessage(row, authUserId, reactions);
}

export async function handleUploadDirectMessageResource(request, env, db) {
  const auth = await requireStableAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  if (!env.R2_BUCKET) return jsonResponse({ success: false, error: '消息资源存储暂不可用' }, 503);

  let form;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ success: false, error: '消息资源上传格式无效' }, 400);
  }
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    return jsonResponse({ success: false, error: '缺少消息资源文件' }, 400);
  }
  const size = Number(file.size ?? 0);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MESSAGE_RESOURCE_BYTES) {
    return jsonResponse({ success: false, error: '消息资源大小无效' }, 400);
  }
  const resourceId = crypto.randomUUID();
  const name = String(file.name || 'attachment').trim().slice(0, 255) || 'attachment';
  const contentType = String(file.type || 'application/octet-stream').trim().slice(0, 255)
    || 'application/octet-stream';
  const objectKey = `private/message-resources/${auth.userId}/${resourceId}`;
  const createdAt = new Date().toISOString();
  const bytes = await file.arrayBuffer();
  try {
    await env.R2_BUCKET.put(objectKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: { resourceId, ownerUserId: String(auth.userId), originalName: name },
    });
    await db.prepare(`
      INSERT INTO direct_message_resources (
        id, owner_user_id, object_key, name, content_type, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(resourceId, auth.userId, objectKey, name, contentType, size, createdAt).run();
  } catch (error) {
    try { await env.R2_BUCKET.delete(objectKey); } catch {}
    return jsonResponse({ success: false, error: '消息资源保存失败' }, 500);
  }
  return jsonResponse({
    success: true,
    resource: { resourceId, name, contentType, size, createdAt },
  }, 201);
}

export async function handleGetDirectMessageResource(request, env, db, resourceId) {
  const auth = await requireStableAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  if (!env.R2_BUCKET) return jsonResponse({ success: false, error: '消息资源存储暂不可用' }, 503);
  const resource = await db.prepare(`
    SELECT id, owner_user_id, object_key, name, content_type, size
    FROM direct_message_resources
    WHERE id = ?
    LIMIT 1
  `).bind(resourceId).first();
  if (!resource) return jsonResponse({ success: false, error: '消息资源不存在' }, 404);

  let allowed = resource.owner_user_id === auth.userId;
  if (!allowed) {
    const linked = await db.prepare(`
      SELECT dm.id
      FROM direct_messages dm, json_each(dm.attachments_json) attachment
      WHERE json_extract(attachment.value, '$.resourceId') = ?
        AND (dm.sender_user_id = ? OR dm.recipient_user_id = ?)
      LIMIT 1
    `).bind(resourceId, auth.userId, auth.userId).first();
    allowed = Boolean(linked);
  }
  if (!allowed) return jsonResponse({ success: false, error: '无权读取消息资源' }, 403);

  const object = await env.R2_BUCKET.get(resource.object_key);
  if (!object) return jsonResponse({ success: false, error: '消息资源内容不存在' }, 404);
  const headers = new Headers();
  headers.set('Content-Type', resource.content_type || 'application/octet-stream');
  headers.set('Content-Length', String(resource.size));
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(resource.name)}`);
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { status: 200, headers });
}

export async function handleSendDirectMessage(request, env, db) {
  const auth = await requireStableAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const body = await request.json();
  const target = await findUser(
    db,
    body.contactId ?? body.targetUserId ?? body.targetUsername ?? body.username,
  );
  if (!target) return jsonResponse({ success: false, error: '未找到联系人' }, 404);
  if (!(await areFriends(db, auth.userId, target.id))) {
    return jsonResponse({ success: false, error: '只能给已添加的好友发送消息' }, 403);
  }

  const text = String(body.text ?? body.message ?? '').trim();
  if (text.length > MAX_MESSAGE_LENGTH) {
    return jsonResponse({ success: false, error: `消息不能超过 ${MAX_MESSAGE_LENGTH} 个字符` }, 400);
  }
  let attachments;
  try {
    attachments = await canonicalizeMessageResources(db, auth.userId, body.attachments);
  } catch (error) {
    return jsonResponse({ success: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (!text && attachments.length === 0) {
    return jsonResponse({ success: false, error: '消息不能为空' }, 400);
  }
  const clientRequestId = String(body.clientRequestId || '').trim() || null;
  if (clientRequestId && clientRequestId.length > 200) {
    return jsonResponse({ success: false, error: '消息请求编号不能超过 200 个字符' }, 400);
  }
  let replyToMessageId = null;
  if (body.replyToMessageId != null && String(body.replyToMessageId).trim() !== '') {
    const reply = await requirePairMessage(db, body.replyToMessageId, auth.userId, target.id);
    if (!reply) return jsonResponse({ success: false, error: '回复目标不属于当前会话' }, 400);
    replyToMessageId = reply.id;
  }

  const createdAt = new Date().toISOString();
  const attachmentsJson = JSON.stringify(attachments);
  const result = await db.prepare(`
    INSERT INTO direct_messages (
      sender_user_id, sender_username, recipient_user_id,
      recipient_username, body, client_request_id, created_at,
      reply_to_message_id, attachments_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sender_user_id, client_request_id) WHERE client_request_id IS NOT NULL
    DO NOTHING
  `).bind(
    auth.userId, auth.username, target.id, target.username,
    text, clientRequestId, createdAt, replyToMessageId, attachmentsJson,
  ).run();

  let messageId = result.meta?.last_row_id ?? null;
  let deduplicated = false;
  if (
    clientRequestId &&
    (result.meta?.changes === 0 || !messageId || Number(messageId) <= 0)
  ) {
    const existing = await db.prepare(`
      SELECT id FROM direct_messages
      WHERE sender_user_id = ? AND client_request_id = ?
      LIMIT 1
    `).bind(auth.userId, clientRequestId).first();
    if (!existing) {
      return jsonResponse({ success: false, error: '消息保存结果无法确认' }, 500);
    }
    messageId = existing.id;
    deduplicated = true;
  }
  const persistedMessage = await readCanonicalDirectMessage(db, messageId, auth.userId);
  if (!persistedMessage) {
    return jsonResponse({ success: false, error: '消息保存结果无法读取' }, 500);
  }

  return jsonResponse({
    success: true,
    deduplicated,
    message: persistedMessage,
  }, deduplicated ? 200 : 201);
}

export async function handleListDirectMessages(request, env, db) {
  const auth = await requireStableAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const url = new URL(request.url);
  const target = await findUser(
    db,
    url.searchParams.get('contactId') || url.searchParams.get('username'),
  );
  if (!target) return jsonResponse({ success: false, error: '未找到联系人' }, 404);
  if (!(await areFriends(db, auth.userId, target.id))) {
    return jsonResponse({ success: false, error: '只能读取已添加好友的消息' }, 403);
  }
  const limit = clampLimit(url.searchParams.get('limit'), 50, 200);
  const before = (url.searchParams.get('before') || '').trim();
  const afterRaw = (url.searchParams.get('afterId') || '').trim();
  const afterId = afterRaw ? Number(afterRaw) : 0;
  if (before && afterRaw) return jsonResponse({ success: false, error: 'before 与 afterId 不能同时使用' }, 400);
  if (afterRaw && (!Number.isSafeInteger(afterId) || afterId <= 0)) {
    return jsonResponse({ success: false, error: 'afterId 无效' }, 400);
  }
  const query = (url.searchParams.get('q') || '').trim();
  if (query.length > MAX_MESSAGE_SEARCH_LENGTH) {
    return jsonResponse({ success: false, error: '消息搜索内容过长' }, 400);
  }
  const like = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const pair = [auth.userId, target.id, target.id, auth.userId];
  let rows;
  if (afterId > 0) {
    rows = await db.prepare(`
      SELECT id, sender_user_id, sender_username, recipient_user_id,
        recipient_username, body, client_request_id, created_at, read_at,
        reply_to_message_id, attachments_json
      FROM direct_messages
      WHERE ((sender_user_id = ? AND recipient_user_id = ?)
        OR (sender_user_id = ? AND recipient_user_id = ?))
        AND id > ?
        AND (? = '' OR lower(body) LIKE lower(?) ESCAPE '\\')
      ORDER BY id ASC
      LIMIT ?
    `).bind(...pair, afterId, query, like, limit).all();
  } else {
    rows = await db.prepare(`
      SELECT id, sender_user_id, sender_username, recipient_user_id,
        recipient_username, body, client_request_id, created_at, read_at,
        reply_to_message_id, attachments_json
      FROM direct_messages
      WHERE ((sender_user_id = ? AND recipient_user_id = ?)
        OR (sender_user_id = ? AND recipient_user_id = ?))
        AND (? = '' OR created_at < ?)
        AND (? = '' OR lower(body) LIKE lower(?) ESCAPE '\\')
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).bind(...pair, before, before, query, like, limit).all();
    rows.results = (rows.results || []).reverse();
  }
  const sourceRows = rows.results || [];
  const reactions = await loadReactionMap(db, sourceRows.map((row) => row.id), auth.userId);
  const messages = sourceRows.map((row) => mapDirectMessage(row, auth.userId, reactions));
  return jsonResponse({
    success: true,
    data: {
      contact: mapContact(target),
      messages,
      nextAfterId: messages.length === 0 ? afterId || null : messages[messages.length - 1].id,
    },
  });
}

export async function handleSetDirectMessageReaction(request, env, db, messageId) {
  const auth = await requireStableAuth(request, env, db);
  if (auth.error) return jsonResponse({ success: false, error: auth.error }, auth.status);
  const message = await db.prepare(`
    SELECT id, sender_user_id, recipient_user_id
    FROM direct_messages
    WHERE id = ? AND (sender_user_id = ? OR recipient_user_id = ?)
    LIMIT 1
  `).bind(Number(messageId), auth.userId, auth.userId).first();
  if (!message) return jsonResponse({ success: false, error: '消息不存在或无权访问' }, 404);
  const body = await request.json();
  const emoji = String(body.emoji || '').trim();
  const emojiBytes = new TextEncoder().encode(emoji).byteLength;
  if (!emoji || emojiBytes > 32) {
    return jsonResponse({ success: false, error: '消息表情无效' }, 400);
  }
  const active = body.active !== false;
  if (active) {
    await db.prepare(`
      INSERT INTO direct_message_reactions (message_id, user_id, emoji, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(message_id, user_id, emoji) DO NOTHING
    `).bind(message.id, auth.userId, emoji, new Date().toISOString()).run();
  } else {
    await db.prepare(`
      DELETE FROM direct_message_reactions
      WHERE message_id = ? AND user_id = ? AND emoji = ?
    `).bind(message.id, auth.userId, emoji).run();
  }
  const reactions = await loadReactionMap(db, [message.id], auth.userId);
  return jsonResponse({
    success: true,
    messageId: message.id,
    reactions: reactions.get(message.id) || [],
  });
}
