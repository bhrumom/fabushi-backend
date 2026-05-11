import test from 'node:test';
import assert from 'node:assert/strict';

import { generateToken, verifyToken } from '../auth-utils.js';
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
          const oldUsername = user.username;
          const assignments = normalizedSql
            .slice('UPDATE users SET'.length, normalizedSql.indexOf(whereById ? 'WHERE id = ?' : 'WHERE username = ?'))
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
          assignments.forEach((assignment, index) => {
            const match = assignment.match(/^([a-zA-Z0-9_]+)\s*=\s*\?$/);
            if (match) user[match[1]] = params[index];
          });
          if (oldUsername !== user.username) {
            users.delete(oldUsername);
          }
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
      const id = nextId++;
      const user = {
        id,
        user_no: extra.user_no ?? id,
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
        username_changed_at: extra.username_changed_at ?? null,
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

test('handleUpdateProfile accepts explicit displayName field and keeps username stable', async () => {
  const db = createDbMock();
  const user = db.seedUser('display_name_user', 'display@example.com', '+8613800138009', { nickname: '旧显示名' });

  const response = await updateProfile(db, { id: user.id, username: user.username }, {
    displayName: '新显示名',
    email: 'display@example.com',
    phoneNumber: '+8613800138009'
  });

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.user.userId, user.id);
  assert.equal(payload.user.username, 'display_name_user');
  assert.equal(payload.user.nickname, '新显示名');
  assert.equal(db.users.get('display_name_user').nickname, '新显示名');
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

test('handleUpdateProfile persists avatar updates in the returned payload and stored user', async () => {
  const db = createDbMock();
  const user = db.seedUser('avatar_user', 'avatar@example.com', '+8613800138111', {
    nickname: '旧头像昵称',
    avatar: 'https://example.com/old-avatar.png'
  });
  const avatar = 'https://example.com/new-avatar.png';

  const response = await updateProfile(db, { id: user.id, username: user.username }, {
    nickname: '新头像昵称',
    email: 'avatar@example.com',
    phoneNumber: '+8613800138111',
    avatar
  });

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.user.userId, user.id);
  assert.equal(payload.user.nickname, '新头像昵称');
  assert.equal(payload.user.avatar, avatar);
  assert.equal(db.users.get('avatar_user').avatar, avatar);
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

test('handleUpdateProfile blocks username rename within one year window', async () => {
  const db = createDbMock();
  const recentChangeAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const expectedNextDate = new Date(Date.parse(recentChangeAt) + 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const user = db.seedUser('rename_locked', 'locked@example.com', '+8613800138440', {
    nickname: '改名受限',
    username_changed_at: recentChangeAt,
  });

  const response = await updateProfile(db, { id: user.id, username: user.username }, {
    username: 'rename_unlocked_later',
    email: 'locked@example.com',
    phoneNumber: '+8613800138440'
  });

  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.error, `用户名一年只能修改一次，请在${expectedNextDate}后再试`);
  assert.equal(db.users.has('rename_locked'), true);
  assert.equal(db.users.has('rename_unlocked_later'), false);
});

test('handleUpdateProfile renames username, rotates token, and refreshes email mapping', async () => {
  const db = createDbMock();
  const user = db.seedUser('stable_1', 'stable@example.com', '+8613800138444', { nickname: '旧昵称' });

  const response = await updateProfile(db, { id: user.id, username: user.username }, {
    username: 'stable-renamed',
    email: 'stable@example.com',
    phoneNumber: '+8613800138444'
  });

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.user.userId, user.id);
  assert.equal(payload.user.username, 'stable-renamed');
  assert.equal(payload.user.nickname, '旧昵称');
  assert.ok(payload.token);
  assert.ok(payload.user.userNo);
  assert.ok(payload.user.usernameChangedAt);
  assert.equal(db.users.has('stable_1'), false);
  assert.equal(db.users.get('stable-renamed').id, user.id);
  assert.ok(db.users.get('stable-renamed').username_changed_at);
  assert.equal(db.emailMapping.get('stable@example.com').username, 'stable-renamed');

  const tokenPayload = await verifyToken(payload.token, { JWT_SECRET: 'test-secret' });
  assert.equal(tokenPayload.userId, user.id);
  assert.equal(tokenPayload.username, 'stable-renamed');
});
