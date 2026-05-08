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
    await this.db.prepare(`
      INSERT INTO users (id, username, email, password_hash, salt, iterations, algo, email_verified, membership_type, free_trial_end_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
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

    const createdUser = await this.getUserById(userId);
    if (!createdUser) throw new Error('创建用户后无法重新读取 users.id');

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
    await this.db.prepare(`
      INSERT INTO users (id, username, email, phone_number, firebase_uid, password_hash, salt, iterations, algo, email_verified, membership_type, free_trial_end_date, created_at)
      VALUES (?, ?, ?, ?, ?, '', '', 0, '', 1, ?, ?, ?)
    `).bind(
      userId,
      userData.username,
      userData.email,
      userData.phoneNumber,
      userData.firebaseUid,
      userData.membershipType,
      userData.freeTrialEndDate,
      userData.createdAt
    ).run();
    return await this.getUserById(userId);
  }

  async getUserByAppleId(appleUserId) {
    return await this.db.prepare('SELECT * FROM users WHERE apple_user_id = ?').bind(appleUserId).first();
  }

  async createAppleUser(userData) {
    const userId = await this.generateUniqueUserId();
    await this.db.prepare(`
      INSERT INTO users (id, username, email, apple_user_id, nickname, password_hash, salt, iterations, algo, email_verified, membership_type, membership_expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, '', '', 0, '', 1, ?, ?, ?)
    `).bind(
      userId,
      userData.username,
      userData.email,
      userData.appleUserId,
      userData.nickname,
      userData.membershipType,
      userData.membershipExpiresAt,
      userData.createdAt
    ).run();
    const createdUser = await this.getUserById(userId);
    if (!createdUser) throw new Error('创建 Apple 用户后无法重新读取 users.id');
    if (userData.email) {
      await this.db.prepare(
        'INSERT OR REPLACE INTO email_username_mapping (email, username, user_id) VALUES (?, ?, ?)'
      ).bind(userData.email, userData.username, createdUser.id).run();
    }
    return createdUser;
  }

  async generateUniqueUserId() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const candidate = generateSixDigitId();
      const existing = await this.getUserById(candidate);
      if (!existing) return candidate;
    }
    throw new Error('无法生成可用的 6 位用户 ID');
  }
}

function generateSixDigitId() {
  while (true) {
    const candidate = Math.floor(100000 + Math.random() * 900000);
    if (!hasObviousPattern(candidate)) {
      return candidate;
    }
  }
}

function hasObviousPattern(value) {
  const text = String(value);
  if (!/^\d{6}$/.test(text)) return true;
  if (/^(\d)\1{5}$/.test(text)) return true;

  let ascending = true;
  let descending = true;
  for (let index = 1; index < text.length; index += 1) {
    const previous = Number(text[index - 1]);
    const current = Number(text[index]);
    if (current !== previous + 1) ascending = false;
    if (current !== previous - 1) descending = false;
  }

  return ascending || descending;
}
