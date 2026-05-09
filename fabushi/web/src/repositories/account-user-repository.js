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

  async renameUsernameReferences({ userId, oldUsername, newUsername }) {
    if (!oldUsername || !newUsername || oldUsername === newUsername) return;

    const updates = [
      ['UPDATE email_username_mapping SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE alipay_bindings SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE orders SET username = ? WHERE account_user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE purchase_history SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE redeem_history SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE memberships SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE meditation_records SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE meditation_goals SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE meditation_settings SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE meditation_groups SET owner_username = ? WHERE owner_user_id = ? OR owner_username = ?', newUsername, userId, oldUsername],
      ['UPDATE meditation_group_members SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE user_follows SET follower_username = ? WHERE follower_user_id = ? OR follower_username = ?', newUsername, userId, oldUsername],
      ['UPDATE user_follows SET following_username = ? WHERE following_user_id = ? OR following_username = ?', newUsername, userId, oldUsername],
      ['UPDATE notifications SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE notifications SET related_username = ? WHERE related_user_id = ? OR related_username = ?', newUsername, userId, oldUsername],
      ['UPDATE sync_log SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE user_sync_state SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE comments SET username = ? WHERE account_user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE likes SET username = ? WHERE username = ?', newUsername, oldUsername],
      ['UPDATE favorites SET username = ? WHERE username = ?', newUsername, oldUsername],
      ['UPDATE content_likes SET username = ? WHERE account_user_id = ? OR username = ?', newUsername, userId, oldUsername],
      ['UPDATE content_favorites SET username = ? WHERE user_id = ? OR username = ?', newUsername, userId, oldUsername],
    ];

    for (const [sql, ...params] of updates) {
      await safeRun(this.db, sql, ...params);
    }
  }
}
