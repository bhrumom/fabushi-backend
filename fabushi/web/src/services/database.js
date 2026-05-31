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
    if (typeof db?.transaction === 'function') this.transaction = db.transaction.bind(db);
    if (typeof db?.batch === 'function') this.batch = db.batch.bind(db);
  }

  prepare(query) {
    return this.db.prepare(query);
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
    const binding = await this.db.prepare(
      'SELECT user_id, username FROM alipay_bindings WHERE alipay_user_id = ?'
    ).bind(alipayUserId).first();
    if (binding?.user_id !== undefined && binding?.user_id !== null) {
      const user = await this.getUserById(binding.user_id);
      if (user) return user;
    }
    if (binding?.username) {
      const user = await this.getUser(binding.username);
      if (user) return user;
    }
    return await this.db.prepare('SELECT * FROM users WHERE alipay_user_id = ?').bind(alipayUserId).first();
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

  async createOrder(orderData) {
    const user = orderData.userId
      ? await this.getUser(orderData.userId)
      : null;
    const username = orderData.username || user?.username || orderData.userId;
    const accountUserId = orderData.accountUserId ?? user?.id ?? null;

    await this.db.prepare(`
      INSERT INTO orders (
        order_id, username, account_user_id, plan, amount, original_amount,
        is_admin_order, status, platform, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      orderData.orderId,
      username,
      accountUserId,
      orderData.plan,
      String(orderData.amount),
      orderData.originalAmount == null ? null : String(orderData.originalAmount),
      orderData.isAdminOrder ? 1 : 0,
      orderData.status,
      orderData.platform || null,
      orderData.createdAt
    ).run();
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
    await this.db.prepare(`
      INSERT INTO purchase_history (
        username, user_id, order_id, plan, amount, currency, status,
        payment_method, purchased_at, valid_from, valid_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      data.username,
      data.userId ?? user?.id ?? null,
      data.orderId,
      data.plan,
      String(data.amount),
      data.currency || 'CNY',
      data.status,
      data.paymentMethod,
      data.purchasedAt,
      data.validFrom,
      data.validTo
    ).run();
  }

  async getPurchaseHistory(username) {
    const result = await this.db.prepare(`
      SELECT *
      FROM purchase_history
      WHERE username = ?
         OR user_id = (SELECT id FROM users WHERE username = ?)
      ORDER BY purchased_at DESC
    `).bind(username, username).all();
    return result.results || [];
  }

  async addRedeemHistory(data) {
    const user = data.username ? await this.getUser(data.username) : null;
    await this.db.prepare(`
      INSERT INTO redeem_history (
        username, user_id, code, type, days, redeemed_at, valid_from, valid_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      data.username,
      data.userId ?? user?.id ?? null,
      data.code,
      data.type,
      data.days,
      data.redeemedAt,
      data.validFrom,
      data.validTo
    ).run();
  }

  async getRedeemHistory(username) {
    const result = await this.db.prepare(`
      SELECT *
      FROM redeem_history
      WHERE username = ?
         OR user_id = (SELECT id FROM users WHERE username = ?)
      ORDER BY redeemed_at DESC
    `).bind(username, username).all();
    return result.results || [];
  }

  async hasCompletedPurchase(username, productId) {
    const row = await this.db.prepare(`
      SELECT id
      FROM purchase_history
      WHERE plan = ?
        AND status = 'completed'
        AND (
          username = ?
          OR user_id = (SELECT id FROM users WHERE username = ?)
        )
      LIMIT 1
    `).bind(productId, username, username).first();
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
