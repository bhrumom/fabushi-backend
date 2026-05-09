import { AccountUserRepository as BaseAccountUserRepository } from './account-user-repository.js';

async function safeRun(db, sql, ...params) {
  try {
    await db.prepare(sql).bind(...params).run();
  } catch (error) {
    console.warn('账户资料引用更新跳过:', error?.message || error);
  }
}

function resolveDurableObjectStorage(db) {
  return db?.state?.storage || db?.db?.state?.storage || null;
}

export class AccountUserRepository extends BaseAccountUserRepository {
  async getByFirebaseUid(firebaseUid) {
    return await this.db.getUserByFirebaseUid(firebaseUid);
  }

  async getByAppleId(appleUserId) {
    return await this.db.getUserByAppleId(appleUserId);
  }

  async createRegisteredUser(user) {
    return await this.db.createUser(user);
  }

  async createPhoneUser(user) {
    return await this.db.createPhoneUser(user);
  }

  async createAppleUser(user) {
    return await this.db.createAppleUser(user);
  }

  async withTransaction(action) {
    if (typeof this.db.transaction === 'function') {
      return await this.db.transaction(action);
    }

    const storage = resolveDurableObjectStorage(this.db);
    if (typeof storage?.transaction === 'function') {
      return await storage.transaction(async () => await action());
    }

    // Cloudflare storage may reject explicit SQL transaction-control
    // statements. When a JavaScript transaction API is unavailable, keep the
    // deletion flow idempotent and run the cleanup directly instead of failing
    // before the first DELETE.
    return await action();
  }

  async deleteAccountArtifacts({ userId, username, email }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const resolvedUserId = userId ?? username;
    const deletions = [
      ['DELETE FROM meditation_group_members WHERE group_id IN (SELECT id FROM meditation_groups WHERE owner_username = ?)', username],
      ['DELETE FROM meditation_groups WHERE owner_username = ?', username],
      ['DELETE FROM meditation_group_members WHERE username = ?', username],
      ['DELETE FROM meditation_records WHERE username = ?', username],
      ['DELETE FROM meditation_goals WHERE username = ?', username],
      ['DELETE FROM meditation_settings WHERE username = ?', username],
      ['DELETE FROM user_practice_privacy WHERE username = ?', username],
      ['DELETE FROM user_follows WHERE follower_username = ? OR following_username = ?', username, username],
      ['DELETE FROM notifications WHERE username = ? OR related_username = ?', username, username],
      ['DELETE FROM sync_log WHERE username = ?', username],
      ['DELETE FROM user_sync_state WHERE username = ?', username],
      ['DELETE FROM comments WHERE user_id = ? OR username = ?', resolvedUserId, username],
      ['DELETE FROM likes WHERE username = ?', username],
      ['DELETE FROM favorites WHERE username = ?', username],
      ['DELETE FROM content_likes WHERE user_id = ? OR username = ?', resolvedUserId, username],
      ['DELETE FROM content_favorites WHERE username = ?', username],
      ['DELETE FROM content_reports WHERE reporter_user_id = ?', resolvedUserId],
      ['DELETE FROM user_blocks WHERE blocked_user_id = ?', resolvedUserId],
      ['DELETE FROM email_username_mapping WHERE username = ?', username],
    ];

    if (normalizedEmail) {
      deletions.push(['DELETE FROM email_username_mapping WHERE email = ?', normalizedEmail]);
    }

    for (const [sql, ...params] of deletions) {
      await safeRun(this.db, sql, ...params);
    }
  }

  async deleteByUsername(username) {
    if (this.db.deleteUser) {
      return await this.db.deleteUser(username);
    }
    return await this.db.prepare('DELETE FROM users WHERE username = ?').bind(username).run();
  }
}
