async function safeRun(db, sql, ...params) {
  try {
    await db.prepare(sql).bind(...params).run();
  } catch (error) {
    console.warn('账户资料引用更新跳过:', error?.message || error);
  }
}

export class AccountUserRepository {
  constructor(db) {
    this.db = db;
  }

  async getByUsername(username) {
    return await this.db.getUser(username);
  }

  async getById(userId) {
    if (!this.db.getUserById) return null;
    return await this.db.getUserById(userId);
  }

  async getByEmail(email) {
    return await this.db.getUserByEmail(email);
  }

  async getByPhone(phoneNumber) {
    return await this.db.getUserByPhone(phoneNumber);
  }

  async resolveTokenUser(tokenData) {
    if (tokenData?.userId !== undefined && tokenData?.userId !== null && this.db.getUserById) {
      const user = await this.db.getUserById(tokenData.userId);
      if (user) return user;
    }
    if (tokenData?.username) {
      return await this.db.getUser(tokenData.username);
    }
    return null;
  }

  async updateById(userId, updates) {
    const fields = Object.keys(updates);
    if (!fields.length) return;

    const assignments = fields.map((key) => `${key} = ?`).join(', ');
    const values = fields.map((key) => updates[key]);
    await this.db.prepare(`UPDATE users SET ${assignments}, updated_at = ? WHERE id = ?`)
      .bind(...values, new Date().toISOString(), Number(userId))
      .run();
  }

  async replaceEmailMapping({ userId, username, oldEmail, newEmail }) {
    if (oldEmail) {
      await safeRun(this.db, 'DELETE FROM email_username_mapping WHERE email = ?', oldEmail.toLowerCase());
    }
    if (userId !== undefined && userId !== null) {
      await safeRun(this.db, 'DELETE FROM email_username_mapping WHERE user_id = ?', userId);
    }
    if (newEmail) {
      await safeRun(
        this.db,
        'INSERT OR REPLACE INTO email_username_mapping (email, username, user_id) VALUES (?, ?, ?)',
        newEmail,
        username,
        userId
      );
    }
  }
}
