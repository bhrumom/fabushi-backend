import { generateUserNo } from './external-numbers.js';

export const USER_ID_CUSTOM_EPOCH_MS = Date.UTC(2025, 0, 1);
const USER_ID_TIMESTAMP_BITS = 41;
const USER_ID_WORKER_BITS = 5;
const USER_ID_SEQUENCE_BITS = 7;
const USER_ID_MAX_TIMESTAMP_DELTA = (2 ** USER_ID_TIMESTAMP_BITS) - 1;
export const USER_ID_MAX_WORKER_ID = (2 ** USER_ID_WORKER_BITS) - 1;
export const USER_ID_MAX_SEQUENCE = (2 ** USER_ID_SEQUENCE_BITS) - 1;
const USER_ID_WORKER_MULTIPLIER = 2 ** USER_ID_SEQUENCE_BITS;
const USER_ID_TIMESTAMP_MULTIPLIER = 2 ** (USER_ID_WORKER_BITS + USER_ID_SEQUENCE_BITS);

const globalState = globalThis.__fabushiUserIdSnowflakeState;
const USER_ID_GENERATOR_STATE = globalState || createSnowflakeUserIdState();
if (!globalState) {
  globalThis.__fabushiUserIdSnowflakeState = USER_ID_GENERATOR_STATE;
}

function createDefaultSnowflakeWorkerId() {
  return Math.floor(Math.random() * (USER_ID_MAX_WORKER_ID + 1));
}

export function normalizeSnowflakeWorkerId(workerId) {
  const parsed = Number(workerId);
  if (!Number.isFinite(parsed)) return 0;
  return Math.abs(Math.trunc(parsed)) % (USER_ID_MAX_WORKER_ID + 1);
}

export function createSnowflakeUserIdState(workerId = createDefaultSnowflakeWorkerId()) {
  return {
    workerId: normalizeSnowflakeWorkerId(workerId),
    lastTimestamp: -1,
    sequence: 0,
  };
}

export function generateSnowflakeUserId({
  nowMs = Date.now(),
  workerId = USER_ID_GENERATOR_STATE.workerId,
  state = USER_ID_GENERATOR_STATE,
} = {}) {
  const normalizedWorkerId = normalizeSnowflakeWorkerId(workerId);
  let timestamp = Math.max(Math.trunc(nowMs), state.lastTimestamp);

  if (timestamp === state.lastTimestamp) {
    if (state.sequence >= USER_ID_MAX_SEQUENCE) {
      timestamp = state.lastTimestamp + 1;
      state.sequence = 0;
    } else {
      state.sequence += 1;
    }
  } else {
    state.sequence = 0;
  }

  state.lastTimestamp = timestamp;
  state.workerId = normalizedWorkerId;

  const timestampDelta = timestamp - USER_ID_CUSTOM_EPOCH_MS;
  if (timestampDelta < 0) {
    throw new Error('用户 ID 时间戳早于自定义 epoch');
  }
  if (timestampDelta > USER_ID_MAX_TIMESTAMP_DELTA) {
    throw new Error('用户 ID 时间戳超出雪花式范围');
  }

  return (
    timestampDelta * USER_ID_TIMESTAMP_MULTIPLIER +
    normalizedWorkerId * USER_ID_WORKER_MULTIPLIER +
    state.sequence
  );
}

// D1数据库服务
export class DatabaseService {
  constructor(db) {
    this.db = db;
    this.state = db?.state;
    this.tableColumnsCache = new Map();
    if (typeof db?.transaction === 'function') this.transaction = db.transaction.bind(db);
    if (typeof db?.batch === 'function') this.batch = db.batch.bind(db);
  }

  prepare(query) {
    return this.db.prepare(query);
  }

  async getTableColumns(tableName) {
    if (this.tableColumnsCache.has(tableName)) {
      return this.tableColumnsCache.get(tableName);
    }

    const result = await this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    const columns = new Set((result.results || []).map((column) => column.name));
    this.tableColumnsCache.set(tableName, columns);
    return columns;
  }

  async insertKnownColumns(tableName, valuesByColumn) {
    const columns = await this.getTableColumns(tableName);
    const insertColumns = Object.keys(valuesByColumn)
      .filter((column) => columns.has(column) && valuesByColumn[column] !== undefined);

    if (insertColumns.length === 0) {
      throw new Error(`No known columns available for ${tableName}`);
    }

    const placeholders = insertColumns.map(() => '?').join(', ');
    const values = insertColumns.map((column) => valuesByColumn[column]);
    await this.db.prepare(`
      INSERT INTO ${tableName} (${insertColumns.join(', ')})
      VALUES (${placeholders})
    `).bind(...values).run();
  }

  async getIdentityValues(username, userId = null) {
    const values = [];
    if (username) values.push(username);
    if (userId !== undefined && userId !== null) values.push(userId, String(userId));
    if (username && userId === null) {
      const user = await this.getUser(username);
      if (user?.id !== undefined && user?.id !== null) values.push(user.id, String(user.id));
    }
    return [...new Map(values.map((value) => [String(value), value])).values()];
  }

  async buildUserHistoryFilter(tableName, username, userId = null) {
    const columns = await this.getTableColumns(tableName);
    const conditions = [];
    const params = [];

    if (columns.has('username') && username) {
      conditions.push('username = ?');
      params.push(username);
    }

    if (columns.has('user_id')) {
      const identities = await this.getIdentityValues(username, userId);
      if (identities.length > 0) {
        conditions.push(`user_id IN (${identities.map(() => '?').join(', ')})`);
        params.push(...identities);
      }
    }

    if (conditions.length === 0) {
      return { where: '1 = 0', params: [] };
    }

    return { where: `(${conditions.join(' OR ')})`, params };
  }

  async getUser(username) {
    return await this.db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  }

  async getUserById(userId) {
    const normalizedId = Number(userId);
    if (!Number.isFinite(normalizedId)) return null;
    return await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(normalizedId).first();
  }

  async getUserByUserNo(userNo) {
    const normalizedUserNo = Number(userNo);
    if (!Number.isFinite(normalizedUserNo)) return null;
    return await this.db.prepare('SELECT * FROM users WHERE user_no = ?').bind(normalizedUserNo).first();
  }

  async getUserByAlipayId(alipayUserId) {
    const identifiers = [...new Set(
      [alipayUserId]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => String(value).trim())
        .filter(Boolean)
    )];

    for (const identifier of identifiers) {
      const binding = await this.db.prepare(
        'SELECT user_id, username FROM alipay_bindings WHERE alipay_user_id = ?'
      ).bind(identifier).first();
      if (binding?.user_id !== undefined && binding?.user_id !== null) {
        const user = await this.getUserById(binding.user_id);
        if (user) return user;
      }
      if (binding?.username) {
        const user = await this.getUser(binding.username);
        if (user) return user;
      }
    }

    for (const identifier of identifiers) {
      const user = await this.db.prepare(
        'SELECT * FROM users WHERE alipay_user_id = ?'
      ).bind(identifier).first();
      if (user) return user;
    }

    return null;
  }

  async getUserByEmail(email) {
    const mapping = await this.db.prepare(
      'SELECT user_id, username FROM email_username_mapping WHERE email = ?'
    ).bind(email).first();
    if (mapping?.user_id !== undefined && mapping?.user_id !== null) {
      const user = await this.getUserById(mapping.user_id);
      if (user) return user;
    }
    if (mapping?.username) {
      const user = await this.getUser(mapping.username);
      if (user) return user;
    }
    return await this.db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  }

  async createUser(userData) {
    const userId = await this.generateUniqueUserId();
    const userNo = await this.generateUniqueUserNo();
    await this.db.prepare(`
      INSERT INTO users (id, user_no, username, email, password_hash, salt, iterations, algo, email_verified, membership_type, free_trial_end_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      userNo,
      userData.username,
      userData.email,
      userData.passwordHash,
      userData.salt,
      userData.iterations,
      userData.algo,
      userData.emailVerified ? 1 : 0,
      userData.membershipType,
      userData.freeTrialEndDate,
      userData.createdAt
    ).run();

    const createdUser = await this.getCreatedUser(userId, userNo);
    if (!createdUser) throw new Error('创建用户后无法重新读取 users.id / users.user_no');

    await this.db.prepare(
      'INSERT INTO email_username_mapping (email, username, user_id) VALUES (?, ?, ?)'
    ).bind(userData.email, userData.username, createdUser.id).run();

    return createdUser;
  }

  async updateUser(username, updates) {
    const fields = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    await this.db.prepare(`UPDATE users SET ${fields}, updated_at = ? WHERE username = ?`)
      .bind(...values, new Date().toISOString(), username)
      .run();
  }

  async updateUserById(userId, updates) {
    const fields = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    await this.db.prepare(`UPDATE users SET ${fields}, updated_at = ? WHERE id = ?`)
      .bind(...values, new Date().toISOString(), Number(userId))
      .run();
  }

  async getUserByPhone(phoneNumber) {
    return await this.db.prepare('SELECT * FROM users WHERE phone_number = ?').bind(phoneNumber).first();
  }

  async getUserByFirebaseUid(firebaseUid) {
    return await this.db.prepare('SELECT * FROM users WHERE firebase_uid = ?').bind(firebaseUid).first();
  }

  async createPhoneUser(userData) {
    const userId = await this.generateUniqueUserId();
    const userNo = await this.generateUniqueUserNo();
    await this.db.prepare(`
      INSERT INTO users (id, user_no, username, email, phone_number, firebase_uid, password_hash, salt, iterations, algo, email_verified, membership_type, free_trial_end_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '', '', 0, '', 1, ?, ?, ?)
    `).bind(
      userId,
      userNo,
      userData.username,
      userData.email,
      userData.phoneNumber,
      userData.firebaseUid,
      userData.membershipType,
      userData.freeTrialEndDate,
      userData.createdAt
    ).run();
    return await this.getCreatedUser(userId, userNo);
  }

  async getUserByAppleId(appleUserId) {
    return await this.db.prepare('SELECT * FROM users WHERE apple_user_id = ?').bind(appleUserId).first();
  }

  async createAppleUser(userData) {
    const userId = await this.generateUniqueUserId();
    const userNo = await this.generateUniqueUserNo();
    await this.db.prepare(`
      INSERT INTO users (id, user_no, username, email, apple_user_id, nickname, password_hash, salt, iterations, algo, email_verified, membership_type, membership_expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '', '', 0, '', 1, ?, ?, ?)
    `).bind(
      userId,
      userNo,
      userData.username,
      userData.email,
      userData.appleUserId,
      userData.nickname,
      userData.membershipType,
      userData.membershipExpiresAt,
      userData.createdAt
    ).run();
    const createdUser = await this.getCreatedUser(userId, userNo);
    if (!createdUser) throw new Error('创建 Apple 用户后无法重新读取 users.id / users.user_no');
    if (userData.email) {
      await this.db.prepare(
        'INSERT OR REPLACE INTO email_username_mapping (email, username, user_id) VALUES (?, ?, ?)'
      ).bind(userData.email, userData.username, createdUser.id).run();
    }
    return createdUser;
  }

  async getUserByWechatOpenid(openid) {
    return await this.db.prepare('SELECT * FROM users WHERE wechat_openid = ?').bind(openid).first();
  }

  async createWechatUser(userData) {
    const userId = await this.generateUniqueUserId();
    const userNo = await this.generateUniqueUserNo();
    await this.db.prepare(`
      INSERT INTO users (id, user_no, username, email, wechat_openid, wechat_nickname, wechat_headimgurl, nickname, avatar, password_hash, salt, iterations, algo, email_verified, membership_type, membership_expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 0, '', 1, ?, ?, ?)
    `).bind(
      userId,
      userNo,
      userData.username,
      userData.email || null,
      userData.openid,
      userData.wechatNickname || null,
      userData.wechatAvatar || null,
      userData.nickname,
      userData.wechatAvatar || null,
      userData.membershipType,
      userData.membershipExpiresAt,
      userData.createdAt
    ).run();
    const createdUser = await this.getCreatedUser(userId, userNo);
    if (!createdUser) throw new Error('创建 WeChat 用户后无法重新读取 users.id / users.user_no');
    if (userData.email) {
      await this.db.prepare(
        'INSERT OR REPLACE INTO email_username_mapping (email, username, user_id) VALUES (?, ?, ?)'
      ).bind(userData.email, userData.username, createdUser.id).run();
    }
    return createdUser;
  }

  async createOrder(orderData) {
    const user = orderData.userId
      ? await this.getUser(orderData.userId)
      : null;
    const username = orderData.username || user?.username || orderData.userId;
    const accountUserId = orderData.accountUserId ?? user?.id ?? null;

    await this.insertKnownColumns('orders', {
      order_id: orderData.orderId,
      user_id: username,
      username,
      account_user_id: accountUserId,
      plan: orderData.plan,
      amount: String(orderData.amount),
      original_amount: orderData.originalAmount == null ? null : String(orderData.originalAmount),
      is_admin_order: orderData.isAdminOrder ? 1 : 0,
      status: orderData.status,
      platform: orderData.platform || null,
      created_at: orderData.createdAt,
      updated_at: orderData.createdAt,
    });
  }

  async getOrder(orderId) {
    return await this.db.prepare('SELECT * FROM orders WHERE order_id = ?').bind(orderId).first();
  }

  async updateOrder(orderId, updates) {
    const fields = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    await this.db.prepare(`UPDATE orders SET ${fields} WHERE order_id = ?`)
      .bind(...values, orderId)
      .run();
  }

  async createRedeemCode(codeData) {
    await this.db.prepare(`
      INSERT INTO redeem_codes (
        code, type, days, name, description, created_by, created_at, used
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      codeData.code,
      codeData.type,
      codeData.days,
      codeData.name,
      codeData.description,
      codeData.createdBy,
      codeData.createdAt
    ).run();
  }

  async getRedeemCode(code) {
    return await this.db.prepare('SELECT * FROM redeem_codes WHERE code = ? AND used = 0').bind(code).first();
  }

  async useRedeemCode(code, username) {
    await this.db.prepare('UPDATE redeem_codes SET used = 1, used_by = ?, used_at = ? WHERE code = ?')
      .bind(username, new Date().toISOString(), code)
      .run();
  }

  async listRedeemCodes(status, page, limit) {
    let query = 'SELECT * FROM redeem_codes';
    const params = [];
    if (status === 'used') {
      query += ' WHERE used = 1';
    } else if (status === 'unused') {
      query += ' WHERE used = 0';
    }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, (page - 1) * limit);

    const result = await this.db.prepare(query).bind(...params).all();
    const countResult = await this.db.prepare('SELECT COUNT(*) AS total FROM redeem_codes').first();
    const total = Number(countResult?.total) || 0;
    return {
      codes: result.results || [],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async deleteRedeemCode(code) {
    await this.db.prepare('DELETE FROM redeem_codes WHERE code = ?').bind(code).run();
  }

  async addPurchaseHistory(data) {
    const user = data.username ? await this.getUser(data.username) : null;
    const columns = await this.getTableColumns('purchase_history');
    const hasUsernameColumn = columns.has('username');
    await this.insertKnownColumns('purchase_history', {
      username: data.username,
      user_id: hasUsernameColumn ? (data.userId ?? user?.id ?? null) : (data.username || data.userId || user?.id),
      order_id: data.orderId,
      plan: data.plan,
      amount: String(data.amount),
      currency: data.currency || 'CNY',
      status: data.status,
      payment_method: data.paymentMethod,
      purchased_at: data.purchasedAt,
      valid_from: data.validFrom,
      valid_to: data.validTo,
      created_at: data.purchasedAt,
    });
  }

  async getPurchaseHistory(username, userId = null) {
    const filter = await this.buildUserHistoryFilter('purchase_history', username, userId);
    const result = await this.db.prepare(`
      SELECT *
      FROM purchase_history
      WHERE ${filter.where}
      ORDER BY purchased_at DESC
    `).bind(...filter.params).all();
    return result.results || [];
  }

  async addRedeemHistory(data) {
    const user = data.username ? await this.getUser(data.username) : null;
    const columns = await this.getTableColumns('redeem_history');
    const hasUsernameColumn = columns.has('username');
    await this.insertKnownColumns('redeem_history', {
      username: data.username,
      user_id: hasUsernameColumn ? (data.userId ?? user?.id ?? null) : (data.username || data.userId || user?.id),
      code: data.code,
      type: data.type,
      name: data.name || data.type || '',
      days: data.days,
      redeemed_at: data.redeemedAt,
      valid_from: data.validFrom,
      valid_to: data.validTo,
      previous_expiry_date: data.previousExpiryDate || null,
      created_at: data.redeemedAt,
    });
  }

  async getRedeemHistory(username, userId = null) {
    const filter = await this.buildUserHistoryFilter('redeem_history', username, userId);
    const result = await this.db.prepare(`
      SELECT *
      FROM redeem_history
      WHERE ${filter.where}
      ORDER BY redeemed_at DESC
    `).bind(...filter.params).all();
    return result.results || [];
  }

  async hasCompletedPurchase(username, productId, userId = null) {
    const filter = await this.buildUserHistoryFilter('purchase_history', username, userId);
    const row = await this.db.prepare(`
      SELECT id
      FROM purchase_history
      WHERE plan = ?
        AND status = 'completed'
        AND ${filter.where}
      LIMIT 1
    `).bind(productId, ...filter.params).first();
    return !!row;
  }

  async getCreatedUser(userId, userNo) {
    const userById = await this.getUserById(userId);
    if (userById) return userById;
    return await this.getUserByUserNo(userNo);
  }

  async generateUniqueUserId() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const candidate = generateSnowflakeUserId();
      const existing = await this.getUserById(candidate);
      if (!existing) return candidate;
    }
    throw new Error('无法生成可用的雪花式用户 ID');
  }

  async generateUniqueUserNo() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const candidate = generateUserNo();
      const existing = await this.getUserByUserNo(candidate);
      if (!existing) return candidate;
    }
    throw new Error('无法生成可用的 9 位用户号');
  }

  async getLeaderboard(limit = 100) {
    const parsedLimit = Number.parseInt(limit, 10);
    const safeLimit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 100;

    try {
      const result = await this.db.prepare(`
        SELECT
          username,
          nickname,
          avatar,
          alipay_avatar,
          wechat_headimgurl,
          COALESCE(total_transferred_bytes, 0) AS totalBytes,
          last_transfer_at AS latestTransferAt
        FROM users
        WHERE COALESCE(total_transferred_bytes, 0) > 0
        ORDER BY COALESCE(total_transferred_bytes, 0) DESC,
                 COALESCE(last_transfer_at, updated_at, created_at) DESC
        LIMIT ?
      `).bind(safeLimit).all();

      return (result?.results || []).map((entry, index) => ({
        username: entry.username || 'Unknown',
        displayName: entry.nickname || entry.username || 'Unknown',
        avatar: entry.avatar || entry.alipay_avatar || entry.wechat_headimgurl || null,
        totalBytes: Number(entry.totalBytes) || 0,
        totalRecords: 0,
        totalDays: 0,
        latestRecordDate: entry.latestTransferAt || null,
        latestTransferAt: entry.latestTransferAt || null,
        rank: index + 1,
      }));
    } catch (error) {
      console.error('获取全球布施排行榜失败:', error);
      return [];
    }
  }

  async updateTransferData(username, bytes) {
    const normalizedUsername = String(username || '').trim();
    const parsedBytes = Number(bytes);
    const normalizedBytes = Number.isFinite(parsedBytes) ? Math.trunc(parsedBytes) : 0;

    if (!normalizedUsername) {
      throw new Error('缺少用户名，无法更新排行榜数据');
    }
    if (normalizedBytes <= 0) {
      throw new Error('无效的传输字节数，无法更新排行榜数据');
    }

    const now = new Date().toISOString();
    const result = await this.db.prepare(`
      UPDATE users
      SET total_transferred_bytes = COALESCE(total_transferred_bytes, 0) + ?,
          last_transfer_at = ?,
          updated_at = ?
      WHERE username = ?
    `).bind(normalizedBytes, now, now, normalizedUsername).run();

    if (result?.meta?.changes === 0) {
      throw new Error(`用户不存在，无法更新排行榜数据: ${normalizedUsername}`);
    }

    const row = await this.db.prepare(`
      SELECT COALESCE(total_transferred_bytes, 0) AS totalBytes,
             last_transfer_at AS lastTransferAt
      FROM users
      WHERE username = ?
    `).bind(normalizedUsername).first();

    return {
      username: normalizedUsername,
      bytes: normalizedBytes,
      totalBytes: Number(row?.totalBytes) || 0,
      lastTransferAt: row?.lastTransferAt || now,
    };
  }
}
