import test from 'node:test';
import assert from 'node:assert/strict';

import { generateToken } from '../auth-utils.js';
import { handleUpdateProfile } from '../src/handlers/profile.js';
import { DatabaseService } from '../src/services/database.js';

function createDbMock(options = {}) {
  const { nativeTransaction = false, batchTransaction = false } = options;
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

        if (params.some((param) => param === undefined)) {
          throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
        }

        if (/^BEGIN TRANSACTION/.test(normalizedSql) || /^COMMIT/.test(normalizedSql) || /^ROLLBACK/.test(normalizedSql)) {
          return;
        }

        if (normalizedSql.startsWith('SELECT * FROM users WHERE username = ?')) {
          const user = users.get(params[0]);
          return user ? { ...user } : null;
        }

        if (normalizedSql.startsWith('SELECT username FROM email_username_mapping WHERE email = ?')) {
          const username = emailMapping.get(params[0]);
          return username ? { username } : null;
        }

        if (normalizedSql.startsWith('SELECT * FROM users WHERE phone_number = ?')) {
          for (const user of users.values()) {
            if (user.phone_number === params[0]) {
              return { ...user };
            }
          }
          return null;
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
            },
            async first() {
              return execute(params);
            },
            async all() {
              return { results: (await execute(params)) ?? [] };
            }
          };
        },
        first() {
          return execute();
        },
        all() {
          return { results: [] };
        }
      };
    }
  };

  if (nativeTransaction) {
    db.state = {
      storage: {
        async transaction(action) {
          statements.push({ sql: '__native_transaction__', params: [] });
          return action();
        }
      }
    };
  }

  if (batchTransaction) {
    db.batch = async (statementList) => {
      statements.push({ sql: '__d1_batch__', params: [] });
      const results = [];
      for (const statement of statementList) {
        results.push(await statement.run());
      }
      return results;
    };
  }

  return db;
}

function seedUser(db, username, email, phoneNumber, extra = {}) {
  db.users.set(username, {
    username,
    email,
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
    phone_number: phoneNumber,
    firebase_uid: extra.firebase_uid ?? null,
    apple_user_id: null,
    nickname: username,
    avatar: extra.avatar ?? null,
    bio: null,
    main_practice_title: extra.main_practice_title ?? null,
    main_practice_file_path: extra.main_practice_file_path ?? null,
    main_practice_selected_at: extra.main_practice_selected_at ?? null,
    membership_type: 'trial',
    membership_expires_at: null,
    free_trial_end_date: '2026-05-31T00:00:00Z',
    stripe_customer_id: null,
    subscription_id: null,
    total_transferred_bytes: extra.total_transferred_bytes ?? 0,
    last_transfer_at: extra.last_transfer_at ?? null,
    sync_version: extra.sync_version ?? 1,
    extra_data: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-04T00:00:00Z'
  });
  db.emailMapping.set(email, username);
}

test('handleUpdateProfile migrates username changes without direct in-place username update', async () => {
  const db = createDbMock();
  seedUser(db, 'oldname', 'old@example.com', '+8613800138000', {
    firebase_uid: 'firebase-uid-1',
    avatar: 'https://example.com/avatar.png',
    main_practice_title: '心经',
    main_practice_file_path: '/sutras/xinjing.md',
    main_practice_selected_at: '2026-05-01T00:00:00Z',
    total_transferred_bytes: 123,
    last_transfer_at: '2026-05-04T00:00:00Z',
    sync_version: 7
  });

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

  assert.equal(
    db.statements.some(({ sql }) => /^BEGIN TRANSACTION|^COMMIT|^ROLLBACK/.test(sql.trimStart())),
    false
  );
});

test('handleUpdateProfile prefers native storage transactions when available', async () => {
  const db = createDbMock({ nativeTransaction: true });
  seedUser(db, 'nativeold', 'native@example.com', '+8613800138111', {
    firebase_uid: 'firebase-native-uid'
  });

  const env = { JWT_SECRET: 'test-secret' };
  const token = await generateToken('nativeold', env);
  const request = new Request('https://flutter.ombhrum.com/api/auth/update-profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      username: 'nativenew',
      email: 'native@example.com',
      phoneNumber: '+8613800138111'
    })
  });

  const response = await handleUpdateProfile(request, env, db);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.user.username, 'nativenew');
  assert.ok(payload.token);
  assert.equal(db.users.has('nativeold'), false);
  assert.equal(db.users.has('nativenew'), true);
  assert.equal(db.emailMapping.get('native@example.com'), 'nativenew');
  assert.ok(db.statements.some(({ sql }) => sql === '__native_transaction__'));
  assert.equal(
    db.statements.some(({ sql }) => /^BEGIN TRANSACTION|^COMMIT|^ROLLBACK/.test(sql.trimStart())),
    false
  );
});

test('handleUpdateProfile uses D1 batch instead of SQL transactions when available', async () => {
  const db = createDbMock({ batchTransaction: true });
  seedUser(db, 'd1old', 'd1@example.com', '+8613800138333', {
    firebase_uid: 'firebase-d1-uid'
  });

  const env = { JWT_SECRET: 'test-secret' };
  const token = await generateToken('d1old', env);
  const request = new Request('https://flutter.ombhrum.com/api/auth/update-profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      username: 'd1new',
      email: 'd1@example.com',
      phoneNumber: ''
    })
  });

  const response = await handleUpdateProfile(request, env, db);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.user.username, 'd1new');
  assert.ok(payload.token);
  assert.equal(db.users.has('d1old'), false);
  assert.equal(db.users.has('d1new'), true);
  assert.equal(db.users.get('d1new').phone_number, null);
  assert.equal(db.emailMapping.get('d1@example.com'), 'd1new');
  assert.ok(db.statements.some(({ sql }) => sql === '__d1_batch__'));
  assert.equal(
    db.statements.some(({ sql }) => /^BEGIN TRANSACTION|^COMMIT|^ROLLBACK/.test(sql.trimStart())),
    false
  );
});

test('handleUpdateProfile coerces missing optional legacy fields to null during username migration', async () => {
  const db = createDbMock({ batchTransaction: true });
  seedUser(db, 'legacyold', 'legacy@example.com', '+8613800138555', {
    firebase_uid: 'firebase-legacy-uid'
  });

  const legacyUser = db.users.get('legacyold');
  delete legacyUser.alipay_bound_at;
  delete legacyUser.wechat_bound_at;
  delete legacyUser.bio;
  delete legacyUser.membership_expires_at;
  delete legacyUser.stripe_customer_id;
  delete legacyUser.subscription_id;
  delete legacyUser.extra_data;

  const env = { JWT_SECRET: 'test-secret' };
  const token = await generateToken('legacyold', env);
  const request = new Request('https://flutter.ombhrum.com/api/auth/update-profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      username: 'legacynew',
      email: 'legacy@example.com',
      phoneNumber: ''
    })
  });

  const response = await handleUpdateProfile(request, env, db);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.user.username, 'legacynew');
  assert.equal(db.users.get('legacynew').alipay_bound_at, null);
  assert.equal(db.users.get('legacynew').wechat_bound_at, null);
  assert.equal(db.users.get('legacynew').bio, null);
  assert.equal(db.users.get('legacynew').membership_expires_at, null);
  assert.equal(db.users.get('legacynew').stripe_customer_id, null);
  assert.equal(db.users.get('legacynew').subscription_id, null);
  assert.equal(db.users.get('legacynew').extra_data, null);
});

test('DatabaseService preserves native transaction access for profile updates', async () => {
  const rawDb = createDbMock({ nativeTransaction: true });
  seedUser(rawDb, 'wrappedold', 'wrapped@example.com', '+8613800138222', {
    firebase_uid: 'firebase-wrapped-uid'
  });
  const db = new DatabaseService(rawDb);

  const env = { JWT_SECRET: 'test-secret' };
  const token = await generateToken('wrappedold', env);
  const request = new Request('https://flutter.ombhrum.com/api/auth/update-profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      username: 'wrappednew',
      email: 'wrapped@example.com',
      phoneNumber: '+8613800138222'
    })
  });

  const response = await handleUpdateProfile(request, env, db);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.user.username, 'wrappednew');
  assert.ok(payload.token);
  assert.equal(rawDb.users.has('wrappedold'), false);
  assert.equal(rawDb.users.has('wrappednew'), true);
  assert.equal(rawDb.emailMapping.get('wrapped@example.com'), 'wrappednew');
  assert.ok(rawDb.statements.some(({ sql }) => sql === '__native_transaction__'));
  assert.equal(
    rawDb.statements.some(({ sql }) => /^BEGIN TRANSACTION|^COMMIT|^ROLLBACK/.test(sql.trimStart())),
    false
  );
});

test('DatabaseService exposes D1 batch for profile updates', async () => {
  const rawDb = createDbMock({ batchTransaction: true });
  seedUser(rawDb, 'batchwrappedold', 'batchwrapped@example.com', '+8613800138444');
  const db = new DatabaseService(rawDb);

  const env = { JWT_SECRET: 'test-secret' };
  const token = await generateToken('batchwrappedold', env);
  const request = new Request('https://flutter.ombhrum.com/api/auth/update-profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      username: 'batchwrappednew',
      email: 'batchwrapped@example.com',
      phoneNumber: '+8613800138444'
    })
  });

  const response = await handleUpdateProfile(request, env, db);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.user.username, 'batchwrappednew');
  assert.ok(payload.token);
  assert.equal(rawDb.users.has('batchwrappedold'), false);
  assert.equal(rawDb.users.has('batchwrappednew'), true);
  assert.equal(rawDb.emailMapping.get('batchwrapped@example.com'), 'batchwrappednew');
  assert.ok(rawDb.statements.some(({ sql }) => sql === '__d1_batch__'));
  assert.equal(
    rawDb.statements.some(({ sql }) => /^BEGIN TRANSACTION|^COMMIT|^ROLLBACK/.test(sql.trimStart())),
    false
  );
});
