// D1数据库服务
export class DatabaseService {
  constructor(db) {
    this.db = db;
    this.state = db?.state;
    if (typeof db?.transaction === 'function') {
      this.transaction = db.transaction.bind(db);
    }
  }

  // 直接暴露 prepare 方法，允许处理器直接调用 db.prepare()
  prepare(query) {
    return this.db.prepare(query);
  }

  // 用户操作
  async getUser(username) {
    return await this.db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  }

  async getUserByAlipayId(alipayUserId) {
    const binding = await this.db.prepare('SELECT username FROM alipay_bindings WHERE alipay_user_id = ?').bind(alipayUserId).first();
    if (!binding) return null;
    return await this.getUser(binding.username);
  }

  async getUserByEmail(email) {
    const mapping = await this.db.prepare('SELECT username FROM email_username_mapping WHERE email = ?').bind(email).first();
    if (!mapping) return null;
    return await this.getUser(mapping.username);
  }

  async createUser(userData) {
    await this.db.prepare(`
      INSERT INTO users (username, email, password_hash, salt, iterations, algo, email_verified, membership_type, free_trial_end_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userData.username, userData.email, userData.passwordHash, userData.salt,
      userData.iterations, userData.algo, userData.emailVerified ? 1 : 0,
      userData.membershipType, userData.freeTrialEndDate, userData.createdAt
    ).run();

    await this.db.prepare('INSERT INTO email_username_mapping (email, username) VALUES (?, ?)').bind(userData.email, userData.username).run();
  }

  async updateUser(username, updates) {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    await this.db.prepare(`UPDATE users SET ${fields}, updated_at = ? WHERE username = ?`).bind(...values, new Date().toISOString(), username).run();
  }

  async deleteUser(username) {
    const user = await this.getUser(username);
    if (!user) return;
    
    if (user.email) {
      await this.db.prepare('DELETE FROM email_username_mapping WHERE email = ?').bind(user.email).run();
    }
    // TODO: 如果有其他的绑定表（如第三方登录绑定），也建议在此处级联删除
    // 例如苹果、支付宝相关的映射数据。目前以删除主表为主。
    await this.db.prepare('DELETE FROM users WHERE username = ?').bind(username).run();
  }

  // 根据手机号查询用户
  async getUserByPhone(phoneNumber) {
    return await this.db.prepare('SELECT * FROM users WHERE phone_number = ?').bind(phoneNumber).first();
  }

  // 根据Firebase UID查询用户
  async getUserByFirebaseUid(firebaseUid) {
    return await this.db.prepare('SELECT * FROM users WHERE firebase_uid = ?').bind(firebaseUid).first();
  }

  // 创建手机用户 (无密码)
  async createPhoneUser(userData) {
    await this.db.prepare(`
      INSERT INTO users (username, email, phone_number, firebase_uid, password_hash, salt, iterations, algo, email_verified, membership_type, free_trial_end_date, created_at)
      VALUES (?, ?, ?, ?, '', '', 0, '', 1, ?, ?, ?)
    `).bind(
      userData.username, userData.email, userData.phoneNumber, userData.firebaseUid,
      userData.membershipType, userData.freeTrialEndDate, userData.createdAt
    ).run();
  }

  // 根据 Apple User ID 查询用户
  async getUserByAppleId(appleUserId) {
    return await this.db.prepare('SELECT * FROM users WHERE apple_user_id = ?').bind(appleUserId).first();
  }

  // 创建 Apple 用户 (无密码)
  async createAppleUser(userData) {
    await this.db.prepare(`
      INSERT INTO users (username, email, apple_user_id, nickname, password_hash, salt, iterations, algo, email_verified, membership_type, membership_expires_at, created_at)
      VALUES (?, ?, ?, ?, '', '', 0, '', 1, ?, ?, ?)
    `).bind(
      userData.username, userData.email, userData.appleUserId, userData.nickname,
      userData.membershipType, userData.membershipExpiresAt, userData.createdAt
    ).run();
  }

  // 订单操作
  async createOrder(orderData) {
    await this.db.prepare(`
      INSERT INTO orders (order_id, user_id, plan, amount, original_amount, is_admin_order, status, platform, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      orderData.orderId, orderData.userId, orderData.plan, orderData.amount,
      orderData.originalAmount, orderData.isAdminOrder ? 1 : 0,
      orderData.status, orderData.platform, orderData.createdAt
    ).run();
  }

  async getOrder(orderId) {
    return await this.db.prepare('SELECT * FROM orders WHERE order_id = ?').bind(orderId).first();
  }

  async updateOrder(orderId, updates) {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    await this.db.prepare(`UPDATE orders SET ${fields} WHERE order_id = ?`).bind(...values, orderId).run();
  }

  // 兑换码操作
  async createRedeemCode(codeData) {
    await this.db.prepare(`
      INSERT INTO redeem_codes (code, type, days, name, description, created_by, created_at, used)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      codeData.code, codeData.type, codeData.days, codeData.name,
      codeData.description, codeData.createdBy, codeData.createdAt
    ).run();
  }

  async getRedeemCode(code) {
    return await this.db.prepare('SELECT * FROM redeem_codes WHERE code = ? AND used = 0').bind(code).first();
  }

  async useRedeemCode(code, username) {
    await this.db.prepare('UPDATE redeem_codes SET used = 1, used_by = ?, used_at = ? WHERE code = ?').bind(username, new Date().toISOString(), code).run();
  }

  // 购买记录
  async addPurchaseHistory(data) {
    await this.db.prepare(`
      INSERT INTO purchase_history (user_id, order_id, plan, amount, currency, status, payment_method, purchased_at, valid_from, valid_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      data.username, data.orderId, data.plan, data.amount, data.currency,
      data.status, data.paymentMethod, data.purchasedAt, data.validFrom, data.validTo
    ).run();
  }

  async getPurchaseHistory(username) {
    const result = await this.db.prepare('SELECT * FROM purchase_history WHERE user_id = ? ORDER BY purchased_at DESC').bind(username).all();
    return result.results || [];
  }

  // 兑换记录
  async addRedeemHistory(data) {
    await this.db.prepare(`
      INSERT INTO redeem_history (username, code, type, days, redeemed_at, valid_from, valid_to)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      data.username, data.code, data.type, data.days,
      data.redeemedAt, data.validFrom, data.validTo
    ).run();
  }

  async getRedeemHistory(username) {
    const result = await this.db.prepare('SELECT * FROM redeem_history WHERE user_id = ? ORDER BY redeemed_at DESC').bind(username).all();
    return result.results || [];
  }

  // 兑换码列表
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
    const countResult = await this.db.prepare('SELECT COUNT(*) as total FROM redeem_codes').first();

    return {
      codes: result.results,
      total: countResult.total,
      page,
      limit,
      totalPages: Math.ceil(countResult.total / limit)
    };
  }

  async deleteRedeemCode(code) {
    await this.db.prepare('DELETE FROM redeem_codes WHERE code = ?').bind(code).run();
  }

  // 排行榜
  async getLeaderboard(limit) {
    try {
      const result = await this.db.prepare(`
        SELECT username, COALESCE(total_transferred_bytes, 0) as totalBytes
        FROM users 
        WHERE COALESCE(total_transferred_bytes, 0) > 0
        ORDER BY total_transferred_bytes DESC
        LIMIT ?
      `).bind(limit).all();

      if (!result || !result.results) {
        return [];
      }

      return result.results.map((entry, index) => ({
        username: entry.username || 'Unknown',
        totalBytes: entry.totalBytes || 0,
        rank: index + 1
      }));
    } catch (error) {
      console.error('获取排行榜失败:', error);
      return [];
    }
  }

  async updateTransferData(username, bytes) {
    await this.db.prepare(`
      UPDATE users 
      SET total_transferred_bytes = total_transferred_bytes + ?,
          last_transfer_at = ?
      WHERE username = ?
    `).bind(bytes, new Date().toISOString(), username).run();
  }
}
