import test from 'node:test';
import assert from 'node:assert/strict';

import { generateToken } from '../auth-utils.js';
import { routeMeditationRequest } from '../src/routes/meditation-routes.js';

function createDbMock() {
  const groups = new Map();
  const members = new Map();

  const keyFor = (groupId, username) => `${groupId}:${username}`;

  const db = {
    prepare(sql) {
      const normalizedSql = sql.trim().replace(/\s+/g, ' ');

      return {
        bind(...params) {
          return {
            async first() {
              if (normalizedSql.startsWith('SELECT id FROM users WHERE username = ?')) {
                return params[0] === 'group_owner' ? { id: 21 } : null;
              }

              if (normalizedSql.startsWith('SELECT owner_username FROM meditation_groups WHERE id = ?')) {
                const group = groups.get(params[0]);
                return group ? { owner_username: group.owner_username } : null;
              }

              if (normalizedSql.startsWith('SELECT SUM(COALESCE(duration, 0)) as duration FROM meditation_records WHERE username = ? AND record_date = ?')) {
                return { duration: 0 };
              }

              return null;
            },
            async all() {
              if (normalizedSql.startsWith('SELECT id FROM meditation_groups WHERE owner_username = ?')) {
                return { results: [] };
              }

              if (normalizedSql.startsWith('SELECT m.group_id FROM meditation_group_members m JOIN meditation_groups g ON g.id = m.group_id WHERE m.username = ? AND m.status = \'active\'')) {
                return { results: [] };
              }

              if (normalizedSql.includes('FROM meditation_groups g LEFT JOIN users owner ON owner.username = g.owner_username LEFT JOIN meditation_group_members my ON my.group_id = g.id AND my.username = ?')) {
                const [today, username, ...rest] = params;
                void today;
                const limit = rest.at(-1);
                const searchTerms = rest.slice(0, -1).filter((value) => typeof value === 'string');
                const trimmedQuery = searchTerms[0]?.replaceAll('%', '').trim().toLowerCase() ?? '';
                const rows = Array.from(groups.values())
                  .filter((group) => {
                    if (!trimmedQuery) return true;
                    return [group.name, group.description, group.owner_username, group.owner_nickname || '']
                      .some((field) => field.toLowerCase().includes(trimmedQuery));
                  })
                  .slice(0, limit);

                return {
                  results: rows.map((group) => {
                    const member = members.get(keyFor(group.id, username));
                    return {
                      ...group,
                      owner_nickname: group.owner_nickname || null,
                      my_status: member?.status ?? null,
                      my_role: member?.role ?? null,
                      my_warning_message: member?.warning_message ?? null,
                      pending_count: 0,
                      member_count: member ? 1 : 0,
                      total_duration: 0,
                      today_duration: 0,
                    };
                  }),
                };
              }

              return { results: [] };
            },
            async run() {
              return undefined;
            },
          };
        },
      };
    },
  };

  groups.set(21, {
    id: 21,
    owner_username: 'group_owner',
    owner_nickname: '禅修发起人',
    name: '晨光共修',
    description: '每天一起完成早课',
    require_approval: 1,
    daily_goal_minutes: 20,
    cumulative_miss_limit: 5,
    consecutive_miss_limit: 2,
    created_at: '2026-05-05T00:00:00Z',
  });

  members.set(keyFor(21, 'group_owner'), {
    id: 1,
    group_id: 21,
    username: 'group_owner',
    role: 'owner',
    status: 'active',
    warning_message: null,
  });

  return db;
}

test('routeMeditationRequest accepts signed base64url JWTs on meditation group routes', async () => {
  const env = { JWT_SECRET: 'test-secret' };
  const db = createDbMock();
  const token = await generateToken({ id: 21, username: 'group_owner' }, env);

  const response = await routeMeditationRequest({
    pathname: '/api/meditation/groups',
    method: 'GET',
    request: new Request('https://flutter.ombhrum.com/api/meditation/groups?query=%E7%A6%85%E4%BF%AE%E5%8F%91%E8%B5%B7%E4%BA%BA', {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    db,
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.groups.length, 1);
  assert.equal(payload.data.groups[0].ownerName, '禅修发起人');
  assert.equal(payload.data.groups[0].name, '晨光共修');
});

test('routeMeditationRequest rejects tampered meditation JWTs before legacy handoff', async () => {
  const env = { JWT_SECRET: 'test-secret' };
  const db = createDbMock();
  const validToken = await generateToken({ id: 21, username: 'group_owner' }, env);
  const tamperedToken = `${validToken.slice(0, -1)}${validToken.endsWith('a') ? 'b' : 'a'}`;

  const response = await routeMeditationRequest({
    pathname: '/api/meditation/groups',
    method: 'GET',
    request: new Request('https://flutter.ombhrum.com/api/meditation/groups?query=%E6%99%A8%E5%85%89', {
      headers: { Authorization: `Bearer ${tamperedToken}` },
    }),
    env,
    db,
  });

  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.success, false);
  assert.equal(payload.error, '认证失败');
});
