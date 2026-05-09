import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeAccountUser, buildPasswordLoginPayload } from '../src/contracts/account-user.js';
import { DatabaseService } from '../src/services/database.js';

function createDbMock() {
  const state = {
    users: [],
    emailMappings: [],
  };

  return {
    prepare(sql) {
      const normalizedSql = sql.trim().replace(/\s+/g, ' ');
      return {
        bind(...params) {
          return {
            async first() {
              if (normalizedSql === 'SELECT * FROM users WHERE id = ?') {
                return state.users.find((user) => user.id === Number(params[0])) || null;
              }
              if (normalizedSql === 'SELECT * FROM users WHERE user_no = ?') {
                return state.users.find((user) => user.user_no === Number(params[0])) || null;
              }
              if (normalizedSql === 'SELECT * FROM users WHERE email = ?') {
                return state.users.find((user) => user.email === params[0]) || null;
              }
              if (normalizedSql === 'SELECT user_id, username FROM email_username_mapping WHERE email = ?') {
                return state.emailMappings.find((entry) => entry.email === params[0]) || null;
              }
              return null;
            },
            async run() {
              if (normalizedSql.startsWith('INSERT INTO users (id, user_no, username, email, password_hash, salt, iterations, algo, email_verified, membership_type, free_trial_end_date, created_at)')) {
                const [userId, userNo, username, email, passwordHash, salt, iterations, algo, emailVerified, membershipType, freeTrialEndDate, createdAt] = params;
                const user = {
                  id: Number(userId),
                  user_no: Number(userNo),
                  username,
                  email,
                  password_hash: passwordHash,
                  salt,
                  iterations,
                  algo,
                  email_verified: emailVerified,
                  membership_type: membershipType,
                  free_trial_end_date: freeTrialEndDate,
                  created_at: createdAt,
                };
                state.users.push(user);
                return { meta: { last_row_id: user.id } };
              }
              if (normalizedSql === 'INSERT INTO email_username_mapping (email, username, user_id) VALUES (?, ?, ?)') {
                const [email, username, userId] = params;
                state.emailMappings.push({ email, username, user_id: userId });
                return { meta: {} };
              }
              throw new Error(`Unexpected SQL in test: ${normalizedSql}`);
            },
          };
        },
      };
    },
  };
}

test('serializeAccountUser and login payload expose userNo separately from internal id', () => {
  const user = {
    id: 12,
    user_no: 618273941,
    username: 'mingyue',
    email: 'mingyue@example.com',
    nickname: '明月',
    created_at: '2026-05-09T00:00:00Z',
    email_verified: 1,
    membership_type: 'trial',
    free_trial_end_date: '2026-05-16T00:00:00Z',
  };

  const serialized = serializeAccountUser(user);
  assert.equal(serialized.id, 12);
  assert.equal(serialized.userId, 12);
  assert.equal(serialized.userNo, 618273941);

  const payload = buildPasswordLoginPayload({ token: 'token', user });
  assert.equal(payload.userId, 12);
  assert.equal(payload.userNo, 618273941);
  assert.equal(payload.user.userNo, 618273941);
});

test('DatabaseService createUser stores generated user_no while id stays snowflake internal id', async () => {
  const db = createDbMock();
  const service = new DatabaseService(db);

  const created = await service.createUser({
    username: 'liangchen',
    email: 'liangchen@example.com',
    passwordHash: 'hash',
    salt: 'salt',
    iterations: 1,
    algo: 'pbkdf2',
    emailVerified: true,
    membershipType: 'trial',
    freeTrialEndDate: '2026-05-16T00:00:00Z',
    createdAt: '2026-05-09T00:00:00Z',
  });

  assert.equal(Number.isSafeInteger(created.id), true);
  assert.match(String(created.user_no), /^\d{9}$/);
  assert.notEqual(created.user_no, created.id);
});
