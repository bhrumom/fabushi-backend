import test from 'node:test';
import assert from 'node:assert/strict';

import { routeMeditationRequest } from '../src/routes/meditation-routes.js';

function makeToken(username) {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ username }));
  return `${header}.${payload}.signature`;
}

function createGroupDbMock() {
  const state = {
    groups: [],
    members: [],
  };

  return {
    prepare(sql) {
      const normalizedSql = sql.trim().replace(/\s+/g, ' ');
      return {
        bind(...params) {
          return {
            async first() {
              if (normalizedSql === 'SELECT id FROM meditation_groups WHERE id = ?') {
                return state.groups.find((group) => group.id === Number(params[0])) || null;
              }
              if (normalizedSql === 'SELECT id FROM meditation_groups WHERE group_no = ?') {
                const group = state.groups.find((entry) => entry.group_no === Number(params[0]));
                return group ? { id: group.id } : null;
              }
              if (normalizedSql === 'SELECT group_no FROM meditation_groups WHERE id = ?') {
                const group = state.groups.find((entry) => entry.id === Number(params[0]));
                return group ? { group_no: group.group_no } : null;
              }
              if (normalizedSql === 'SELECT id, require_approval, owner_username FROM meditation_groups WHERE id = ?') {
                const group = state.groups.find((entry) => entry.id === Number(params[0]));
                return group
                  ? {
                      id: group.id,
                      require_approval: group.require_approval,
                      owner_username: group.owner_username,
                    }
                  : null;
              }
              return null;
            },
            async run() {
              if (normalizedSql.startsWith('INSERT INTO meditation_groups ( id, group_no, name, description, owner_username')) {
                const [
                  id,
                  groupNo,
                  name,
                  description,
                  ownerUsername,
                  requireApproval,
                  dailyGoalMinutes,
                  cumulativeMissLimit,
                  consecutiveMissLimit,
                  createdAt,
                  updatedAt,
                ] = params;
                state.groups.push({
                  id: Number(id),
                  group_no: Number(groupNo),
                  name,
                  description,
                  owner_username: ownerUsername,
                  require_approval: requireApproval,
                  daily_goal_minutes: dailyGoalMinutes,
                  cumulative_miss_limit: cumulativeMissLimit,
                  consecutive_miss_limit: consecutiveMissLimit,
                  created_at: createdAt,
                  updated_at: updatedAt,
                });
                return { meta: { last_row_id: Number(id) } };
              }
              if (normalizedSql.startsWith('INSERT INTO meditation_group_members (group_id, username, role, status, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT')) {
                const [groupId, username, role, status, joinedAt, updatedAt] = params;
                const existing = state.members.find(
                  (member) => member.group_id === Number(groupId) && member.username === username,
                );
                if (existing) {
                  existing.role = existing.role === 'owner' ? 'owner' : role;
                  existing.status = status;
                  existing.updated_at = updatedAt;
                } else {
                  state.members.push({
                    group_id: Number(groupId),
                    username,
                    role,
                    status,
                    joined_at: joinedAt,
                    updated_at: updatedAt,
                  });
                }
                return { meta: {} };
              }
              if (normalizedSql.startsWith('INSERT INTO meditation_group_members (group_id, username, role, status, joined_at, updated_at)')) {
                const [groupId, username, joinedAt, updatedAt] = params;
                state.members.push({
                  group_id: Number(groupId),
                  username,
                  role: 'owner',
                  status: 'active',
                  joined_at: joinedAt,
                  updated_at: updatedAt,
                });
                return { meta: {} };
              }
              throw new Error(`Unexpected SQL in test: ${normalizedSql}`);
            },
          };
        },
      };
    },
    state,
  };
}

test('creating meditation group uses snowflake internal id and short external groupNo', async () => {
  const db = createGroupDbMock();
  const request = new Request('https://example.com/api/meditation/groups', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${makeToken('mingyue')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '昨修小绔',
      description: '日每共修',
      dailyGoalMinutes: 30,
      cumulativeMissLimit: 7,
      consecutiveMissLimit: 3,
    }),
  });

  const response = await routeMeditationRequest({
    pathname: '/api/meditation/groups',
    method: 'POST',
    request,
    env: {},
    db,
  });

  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.success, true);
  assert.equal(Number.isSafeInteger(payload.data.groupId), true);
  assert.match(String(payload.data.groupNo), /^\d{5}$/);
  assert.notEqual(payload.data.groupId, payload.data.groupNo);
  assert.equal(db.state.groups[0].id, payload.data.groupId);
  assert.equal(db.state.groups[0].group_no, payload.data.groupNo);
  assert.equal(db.state.members[0].group_id, payload.data.groupId);
});

test('joining meditation group keeps request body readable after route rewrite', async () => {
  const db = createGroupDbMock();
  db.state.groups.push({
    id: 1793864023001,
    group_no: 12345,
    owner_username: 'owner',
    require_approval: 1,
  });

  const request = new Request('https://example.com/api/meditation/groups/join', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${makeToken('applicant')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ groupId: 1793864023001 }),
  });

  const response = await routeMeditationRequest({
    pathname: '/api/meditation/groups/join',
    method: 'POST',
    request,
    env: {},
    db,
  });

  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.success, true);
  assert.equal(payload.data.status, 'pending');
  assert.equal(payload.data.message, '已提交加入申请，等待同意');
  assert.equal(db.state.members[0].group_id, 1793864023001);
  assert.equal(db.state.members[0].username, 'applicant');
  assert.equal(db.state.members[0].status, 'pending');
});
