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
}
