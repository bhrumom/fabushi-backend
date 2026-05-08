import test from 'node:test';
import assert from 'node:assert/strict';

import { generateToken } from '../auth-utils.js';
import { handleUpdateProfile } from '../src/handlers/profile.js';

function createDbMock() {
  const users = new Map();
  const usersById = new Map();
  const emailMapping = new Map();
  const statements = [];
  let nextId = 1;

  const db = {
    users,
    usersById,
    emailMapping,
    statements,
    async getUser(username) {
      const user = users.get(username);
      return user ? { ...user } : null;
    },
    async getUserById(id) {
      const user = usersById.get(Number(id));
      return user ? { ...user } : null;
    },
    async getUserByEmail(email) {
      const mapping = emailMapping.get(email);
      if (!mapping) return null;
      if (mapping.user_id !== undefined) return this.getUserById(mapping.user_id);
      return this.getUser(mapping.username);
    },
    async getUserByPhone(phoneNumber) {
      for (const user of users.values()) {
        if (user.phone_number === phoneNumber) return { ...user };
      }
      return null;
    },
    prepare(sql) {
      const normalizedSql = sql.trimStart();
      const execute = async (params = []) => {
        statements.push({ sql: normalizedSql, params });
        if (normalizedSql.startsWith('UPDATE users SET')) {
          const whereById = normalizedSql.includes('WHERE id = ?');
          const key = params.at(-1);
          const user = whereById ? usersById.get(Number(key)) : users.get(key);
          if (!user) return;
          const assignments = normalizedSql
            .slice('UPDATE users SET'.length, normalizedSql.indexOf(whereById ? 'WHERE id = ?' : 'WHERE username = ?'))
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
          assignments.forEach((assignment, index) => {
            const match = assignment.match(/^([a-zA-Z0-9_]+)\s*=\s*\?$/);
            if (match) user[match[1]] = params[index];
          });
          users.set(user.username, user);
          usersById.set(user.id, user);
          return;
        }
        if (normalizedSql.startsWith('DELETE FROM email_username_mapping')) {
          const [arg1, arg2] = params;
          for (const [email, mapping] of [...emailMapping.entries()]) {
            if (mapping.user_id === arg1 || email === arg1 || email === arg2) {
              emailMapping.delete(email);
            }
          }
          return;
        }
        if (normalizedSql.startsWith('INSERT OR REPLACE INTO email_username_mapping')) {
          const [email, username, userId] = params;
          emailMapping.set(email, { username, user_id: userId });
          return;
        }
      };
      return {
        bind(...params) {
          return {
            run: () => execute(params),
            first: () => execute(params)
          };
        },
        run: () => execute()
      };
    },
    seedUser(username, email, phoneNumber, extra = {}) {
      const user = {
        id: nextId++,
        username,
        email,
        password_hash: '',
        salt: '',
        iterations: 0,
        algo: '',
        email_verified: 1,
        phone_number: phoneNumber,
        firebase_uid: extra.firebase_uid ?? null,
        alipay_user_id: extra.alipay_user_id ?? null,
        nickname: extra.nickname ?? username,
        avatar: extra.avatar ?? null,
        membership_type: 'trial',
        membership_expires_at: null,
        free_trial_end_date: '2026-05-31T00:00:00Z',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-04T00:00:00Z'
      };
      users.set(username, user);
      usersById.set(user.id, user);
      if (email) emailMapping.set(email, { username, user_id: user.id });
      return user;
    }
  };
  return db;
}

async function updateProfile(db, tokenIdentity, body) {
  const env = { JWT_SECRET: 'test-secret' };
  const token = await generateToken(tokenIdentity, env);
  const request = new Request('https://flutter.ombhrum.com/api/auth/update-profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  return handleUpdateProfile(request, env, db);
}

test('handleUpdateProfile treats legacy username payload as display name and keeps identity username stable', async () => {
  const db = createDbMock();
  const user = db.seedUser('stable_1', 'stable@example.com', '+8613800138000', { nickname: '旧昵称' });

  const response = await updateProfile(db, { id: user.id, username: user.username }, {
    username: '新昵称',
    email: 'stable@example.com',
    phoneNumber: '+8613800138000'
  });

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.user.userId, user.id);
  assert.equal(payload.user.username, 'stable_1');
  assert.equal(payload.user.nickname, '新昵称');
  assert.equal(db.users.get('stable_1').nickname, '新昵称');
  assert.equal(
    db.statements.some(({ sql }) => sql.includes('WHERE username = ?') && sql.startsWith('UPDATE users SET')),
    false
  );
  assert.equal(
    db.statements.some(({ sql }) => sql.startsWith('INSERT INTO users') || sql.startsWith('DELETE FROM users')),
    false
  );
});

test('handleUpdateProfile uses token userId before mismatched username fallback', async () => {
  const db = createDbMock();
  const rightUser = db.seedUser('real_user', 'real@example.com', '+8613800138001', { nickname: '原昵称' });
  db.seedUser('wrong_user', 'wrong@example.com', '+8613800138002', { nickname: '错用户' });

  const response = await updateProfile(db, { id: rightUser.id, username: 'wrong_user' }, {
    nickname: '只改正确账号',
    email: 'real@example.com',
    phoneNumber: '+8613800138001'
  });

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.user.userId, rightUser.id);
  assert.equal(db.users.get('real_user').nickname, '只改正确账号');
  assert.equal(db.users.get('wrong_user').nickname, '错用户');
});

test('handleUpdateProfile rejects duplicate email by id, not by username', async () => {
  const db = createDbMock();
  const one = db.seedUser('one', 'one@example.com', '+8613800138222');
  db.seedUser('two', 'two@example.com', '+8613800138333');

  const response = await updateProfile(db, { id: one.id, username: one.username }, {
    nickname: '用户一',
    email: 'two@example.com',
    phoneNumber: '+8613800138222'
  });

  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.error, '该邮箱已被其他账号使用');
});
