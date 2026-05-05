import test from 'node:test';
import assert from 'node:assert/strict';

import { generateToken } from '../auth-utils.js';
import { handleUpdateProfile } from '../src/handlers/profile.js';

function createDbMock() {
  const users = new Map();
  const emailMapping = new Map();
  const statements = [];

  const db = {
    users,
    emailMapping,
    statements,
    async getUser(username) {
      const user = users.get(username);
      return user ? { ...user } : null;
    },
    async getUserByEmail(email) {
      const username = emailMapping.get(email);
      if (!username) return null;
      const user = users.get(username);
      return user ? { ...user } : null;
    },
    async getUserByPhone(phoneNumber) {
      for (const user of users.values()) {
        if (user.phone_number === phoneNumber) {
          return { ...user };
        }
      }
      return null;
    },
    prepare(sql) {
      const normalizedSql = sql.trimStart();

      const execute = async (params = []) => {
        statements.push({ sql, params });

        if (/^BEGIN TRANSACTION/.test(normalizedSql) || /^COMMIT/.test(normalizedSql) || /^ROLLBACK/.test(normalizedSql)) {
          return;
        }

        if (normalizedSql.startsWith('UPDATE users') && normalizedSql.includes('phone_number = NULL')) {
          const [placeholderEmail, updatedAt, username] = params;
          const user = users.get(username);
          user.email = placeholderEmail;
          user.phone_number = null;
          user.firebase_uid = null;
          user.apple_user_id = null;
          user.alipay_user_id = null;
          user.wechat_openid = null;
          user.updated_at = updatedAt;
          return;
        }

        if (normalizedSql.startsWith('INSERT INTO users')) {
          const columnsSection = normalizedSql.slice(normalizedSql.indexOf('(') + 1, normalizedSql.indexOf(') VALUES'));
          const columns = columnsSection.split(',').map((column) => column.trim());
          const record = {};
          columns.forEach((column, index) => {
            record[column] = params[index];
          });
          users.set(record.username, record);
          return;
        }

        if (normalizedSql.startsWith('DELETE FROM users')) {
          users.delete(params[0]);
          return;
        }

        if (normalizedSql.startsWith('DELETE FROM email_username_mapping')) {
          emailMapping.delete(params[0]);
          return;
        }

        if (normalizedSql.startsWith('INSERT OR REPLACE INTO email_username_mapping')) {
          emailMapping.set(params[0], params[1]);
        }
      };

      return {
        async run() {
          return execute();
        },
        bind(...params) {
          return {
            async run() {
              return execute(params);
            }
          };
        }
      };
    }
  };

  return db;
}

test('handleUpdateProfile migrates username changes without direct in-place username update', async () => {
  const db = createDbMock();
  db.users.set('oldname', {
    username: 'oldname',
    email: 'old@example.com',
    password_hash: '',
    salt: '',
    iterations: 0,
    algo: '',
    email_verified: 1,
    alipay_user_id: null,
    alipay_nickname: null,
    alipay_avatar: null,
    alipay_bound_at: null,
    wechat_openid: null,
    wechat_nickname: null,
    wechat_headimgurl: null,
    wechat_bound_at: null,
    phone_number: '+8613800138000',
    firebase_uid: 'firebase-uid-1',
    apple_user_id: null,
    nickname: 'oldname',
    avatar: 'https://example.com/avatar.png',
    bio: null,
    main_practice_title: '心经',
    main_practice_file_path: '/sutras/xinjing.md',
    main_practice_selected_at: '2026-05-01T00:00:00Z',
    membership_type: 'trial',
    membership_expires_at: null,
    free_trial_end_date: '2026-05-31T00:00:00Z',
    stripe_customer_id: null,
    subscription_id: null,
    total_transferred_bytes: 123,
    last_transfer_at: '2026-05-04T00:00:00Z',
    sync_version: 7,
    extra_data: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-04T00:00:00Z'
  });
  db.emailMapping.set('old@example.com', 'oldname');

  const env = { JWT_SECRET: 'test-secret' };
  const token = await generateToken('oldname', env);
  const request = new Request('https://flutter.ombhrum.com/api/auth/update-profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      username: 'newname',
      email: 'old@example.com',
      phoneNumber: '+8613800138000'
    })
  });

  const response = await handleUpdateProfile(request, env, db);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.user.username, 'newname');
  assert.equal(payload.user.nickname, 'newname');
  assert.ok(payload.token);

  assert.equal(db.users.has('oldname'), false);
  assert.equal(db.users.has('newname'), true);
  assert.equal(db.users.get('newname').email, 'old@example.com');
  assert.equal(db.users.get('newname').phone_number, '+8613800138000');
  assert.equal(db.users.get('newname').firebase_uid, 'firebase-uid-1');
  assert.equal(db.emailMapping.get('old@example.com'), 'newname');

  const directUsernameUpdate = db.statements.find(({ sql }) =>
    sql.startsWith('UPDATE users SET') && sql.includes('username = ?')
  );
  assert.equal(directUsernameUpdate, undefined);

  const expectedReferenceUpdates = [
    'UPDATE comments SET user_id = ? WHERE user_id = ?',
    'UPDATE content_likes SET user_id = ? WHERE user_id = ?',
    'UPDATE user_practice_privacy SET username = ? WHERE username = ?',
    'UPDATE content_reports SET reporter_user_id = ? WHERE reporter_user_id = ?',
    'UPDATE user_blocks SET blocked_user_id = ? WHERE blocked_user_id = ?'
  ];

  for (const expectedSql of expectedReferenceUpdates) {
    assert.ok(
      db.statements.some(({ sql }) => sql === expectedSql),
      `missing migration statement: ${expectedSql}`
    );
  }
});
