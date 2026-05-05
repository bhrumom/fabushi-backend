import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleGetMeditationGroups,
  handleGetMeditationGroupDetail,
  handleReviewMeditationGroupJoin,
} from '../src/handlers/meditation.js';

function createDbMock() {
  const groups = new Map();
  const members = new Map();

  const keyFor = (groupId, username) => `${groupId}:${username}`;

  const db = {
    groups,
    members,
    prepare(sql) {
      const normalizedSql = sql.trim().replace(/\s+/g, ' ');

      return {
        bind(...params) {
          return {
            async first() {
              if (normalizedSql.startsWith('SELECT owner_username FROM meditation_groups WHERE id = ?')) {
                const group = groups.get(params[0]);
                return group ? { owner_username: group.owner_username } : null;
              }

              if (normalizedSql.startsWith('SELECT id, owner_username, daily_goal_minutes, cumulative_miss_limit, consecutive_miss_limit FROM meditation_groups WHERE id = ?')) {
                const group = groups.get(params[0]);
                return group ? { ...group } : null;
              }

              if (normalizedSql.startsWith('SELECT id, status, role FROM meditation_group_members WHERE group_id = ? AND username = ?')) {
                const member = members.get(keyFor(params[0], params[1]));
                return member ? { id: member.id, status: member.status, role: member.role } : null;
              }

              if (normalizedSql.includes('LEFT JOIN meditation_group_members my ON my.group_id = g.id AND my.username = ? WHERE g.id = ?')) {
                const [today, username, groupId] = params;
                void today;
                const group = groups.get(groupId);
                if (!group) return null;
                const member = members.get(keyFor(groupId, username));
                return {
                  ...group,
                  owner_nickname: null,
                  my_status: member?.status ?? null,
                  my_role: member?.role ?? null,
                  my_warning_message: member?.warning_message ?? null,
                  pending_count: Array.from(members.values()).filter(
                    (entry) => entry.group_id === groupId && entry.status === 'pending',
                  ).length,
                  member_count: Array.from(members.values()).filter(
                    (entry) => entry.group_id === groupId && entry.status === 'active',
                  ).length,
                  total_duration: 0,
                  today_duration: 0,
                };
              }

              if (normalizedSql.startsWith('SELECT SUM(COALESCE(duration, 0)) as duration FROM meditation_records WHERE username = ? AND record_date = ?')) {
                return { duration: 0 };
              }

              return null;
            },
            async all() {
              if (normalizedSql.includes('FROM meditation_groups g LEFT JOIN users owner ON owner.username = g.owner_username LEFT JOIN meditation_group_members my ON my.group_id = g.id AND my.username = ?')) {
                const [today, username, ...rest] = params;
                void today;
                const limit = rest.at(-1);
                const searchTerms = rest.slice(0, -1).filter((value) => typeof value === 'string');
                const groupIdSearch = rest
                  .slice(0, -1)
                  .find((value) => typeof value === 'number');
                const trimmedQuery = searchTerms[0]?.replaceAll('%', '').trim().toLowerCase() ?? '';
                const rows = Array.from(groups.values()).filter((group) => {
                  if (groupIdSearch && group.id === groupIdSearch) return true;
                  if (!trimmedQuery) return true;
                  return [
                    group.name,
                    group.description,
                    group.owner_username,
                    group.owner_nickname || '',
                  ].some((field) => field.toLowerCase().includes(trimmedQuery));
                }).slice(0, limit);

                return {
                  results: rows.map((group) => {
                    const member = members.get(keyFor(group.id, username));
                    return {
                      ...group,
                      owner_nickname: group.owner_nickname || null,
                      my_status: member?.status ?? null,
                      my_role: member?.role ?? null,
                      my_warning_message: member?.warning_message ?? null,
                      pending_count: Array.from(members.values()).filter(
                        (entry) => entry.group_id === group.id && entry.status === 'pending',
                      ).length,
                      member_count: Array.from(members.values()).filter(
                        (entry) => entry.group_id === group.id && entry.status === 'active',
                      ).length,
                      total_duration: 0,
                      today_duration: 0,
                    };
                  }),
                };
              }

              if (normalizedSql.startsWith('SELECT id FROM meditation_groups WHERE owner_username = ?')) {
                return {
                  results: Array.from(groups.values())
                    .filter((group) => group.owner_username === params[0])
                    .map((group) => ({ id: group.id })),
                };
              }

              if (normalizedSql.startsWith('SELECT m.group_id FROM meditation_group_members m JOIN meditation_groups g ON g.id = m.group_id WHERE m.username = ? AND m.status = \'active\'')) {
                return {
                  results: Array.from(members.values())
                    .filter((member) => member.username === params[0] && member.status === 'active')
                    .map((member) => ({ group_id: member.group_id })),
                };
              }

              if (normalizedSql.startsWith('SELECT id, username, joined_at, role FROM meditation_group_members WHERE group_id = ? AND status = \'active\' AND role != \'owner\'')) {
                const [groupId, onlyUsername] = params;
                return {
                  results: Array.from(members.values()).filter((member) => {
                    if (member.group_id !== groupId || member.status !== 'active' || member.role === 'owner') {
                      return false;
                    }
                    return onlyUsername ? member.username === onlyUsername : true;
                  }),
                };
              }

              if (normalizedSql.includes('FROM meditation_group_members m LEFT JOIN users u ON u.username = m.username LEFT JOIN meditation_records r ON r.username = m.username WHERE m.group_id = ? AND m.status = \'active\'')) {
                return {
                  results: Array.from(members.values())
                    .filter((member) => member.group_id === params[1] && member.status === 'active')
                    .map((member) => ({
                      username: member.username,
                      displayName: member.username,
                      avatar: null,
                      role: member.role,
                      cumulative_missed_days: member.cumulative_missed_days ?? 0,
                      consecutive_missed_days: member.consecutive_missed_days ?? 0,
                      warning_message: member.warning_message ?? null,
                      totalDuration: 0,
                      todayDuration: 0,
                      activeDays: 0,
                    })),
                };
              }

              if (normalizedSql.includes('FROM meditation_group_members m LEFT JOIN users u ON u.username = m.username WHERE m.group_id = ? AND m.status = \'pending\'')) {
                return {
                  results: Array.from(members.values())
                    .filter((member) => member.group_id === params[0] && member.status === 'pending')
                    .map((member) => ({
                      username: member.username,
                      displayName: member.username,
                      avatar: null,
                      updated_at: member.updated_at,
                    })),
                };
              }

              if (normalizedSql.startsWith('SELECT record_date, SUM(COALESCE(duration, 0)) as duration FROM meditation_records WHERE username = ? AND record_date >= ? AND record_date <= ? GROUP BY record_date')) {
                return { results: [] };
              }

              return { results: [] };
            },
            async run() {
              if (normalizedSql.startsWith('UPDATE meditation_group_members SET role = \'owner\', status = \'active\'')) {
                const [updatedAt, id] = params;
                const member = Array.from(members.values()).find((entry) => entry.id === id);
                member.role = 'owner';
                member.status = 'active';
                member.cumulative_missed_days = 0;
                member.consecutive_missed_days = 0;
                member.warning_message = null;
                member.removal_reason = null;
                member.removed_at = null;
                member.updated_at = updatedAt;
                return;
              }

              if (normalizedSql.startsWith('INSERT INTO meditation_group_members ( group_id, username, role, status,')) {
                const [groupId, username, joinedAt, updatedAt] = params;
                members.set(keyFor(groupId, username), {
                  id: members.size + 1,
                  group_id: groupId,
                  username,
                  role: 'owner',
                  status: 'active',
                  cumulative_missed_days: 0,
                  consecutive_missed_days: 0,
                  warning_message: null,
                  removal_reason: null,
                  removed_at: null,
                  joined_at: joinedAt,
                  updated_at: updatedAt,
                });
                return;
              }

              if (normalizedSql.startsWith('UPDATE meditation_group_members SET status = ?, joined_at = CASE WHEN ? = \'active\' THEN ? ELSE joined_at END, updated_at = ? WHERE group_id = ? AND username = ? AND status = \'pending\'')) {
                const [status, , joinedAt, updatedAt, groupId, username] = params;
                const member = members.get(keyFor(groupId, username));
                if (member && member.status === 'pending') {
                  member.status = status;
                  member.joined_at = status === 'active' ? joinedAt : member.joined_at;
                  member.updated_at = updatedAt;
                }
                return;
              }

              if (normalizedSql.startsWith('UPDATE meditation_group_members SET cumulative_missed_days = ?,')) {
                const [cumulativeMissed, consecutiveMissed, warningMessage, updatedAt, id] = params;
                const member = Array.from(members.values()).find((entry) => entry.id === id);
                member.cumulative_missed_days = cumulativeMissed;
                member.consecutive_missed_days = consecutiveMissed;
                member.warning_message = warningMessage;
                member.updated_at = updatedAt;
                return;
              }
            },
          };
        },
      };
    },
  };

  return { db, groups, members, keyFor };
}

function authHeader(username) {
  const payload = Buffer.from(JSON.stringify({ username })).toString('base64url');
  return `Bearer header.${payload}.signature`;
}

test('group detail restores removed owner membership and keeps pending requests visible', async () => {
  const { db, groups, members, keyFor } = createDbMock();
  groups.set(7, {
    id: 7,
    owner_username: 'owner1',
    name: '晨课共修',
    description: '',
    require_approval: 1,
    daily_goal_minutes: 30,
    cumulative_miss_limit: 7,
    consecutive_miss_limit: 3,
    created_at: '2026-05-05T00:00:00Z',
  });
  members.set(keyFor(7, 'owner1'), {
    id: 1,
    group_id: 7,
    username: 'owner1',
    role: 'owner',
    status: 'removed',
    cumulative_missed_days: 4,
    consecutive_missed_days: 3,
    warning_message: '已接近清退',
    removal_reason: '连续未达标 3 天',
    removed_at: '2026-05-05T00:00:00Z',
    joined_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-05T00:00:00Z',
  });
  members.set(keyFor(7, 'pending-user'), {
    id: 2,
    group_id: 7,
    username: 'pending-user',
    role: 'member',
    status: 'pending',
    joined_at: '2026-05-05T00:00:00Z',
    updated_at: '2026-05-05T00:00:00Z',
  });

  const response = await handleGetMeditationGroupDetail(
    new Request('https://flutter.ombhrum.com/api/meditation/groups/detail?groupId=7', {
      headers: { Authorization: authHeader('owner1') },
    }),
    {},
    db,
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.group.myStatus, 'active');
  assert.equal(payload.data.group.myRole, 'owner');
  assert.equal(payload.data.pendingMembers.length, 1);

  const ownerMembership = members.get(keyFor(7, 'owner1'));
  assert.equal(ownerMembership.status, 'active');
  assert.equal(ownerMembership.warning_message, null);
  assert.equal(ownerMembership.removal_reason, null);
});

test('group owner can still approve join requests after owner membership is restored', async () => {
  const { db, groups, members, keyFor } = createDbMock();
  groups.set(11, {
    id: 11,
    owner_username: 'owner2',
    name: '晚课共修',
    description: '',
    require_approval: 1,
    daily_goal_minutes: 45,
    cumulative_miss_limit: 6,
    consecutive_miss_limit: 2,
    created_at: '2026-05-05T00:00:00Z',
  });
  members.set(keyFor(11, 'owner2'), {
    id: 5,
    group_id: 11,
    username: 'owner2',
    role: 'owner',
    status: 'removed',
    joined_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-05T00:00:00Z',
  });
  members.set(keyFor(11, 'applicant'), {
    id: 6,
    group_id: 11,
    username: 'applicant',
    role: 'member',
    status: 'pending',
    joined_at: '2026-05-05T00:00:00Z',
    updated_at: '2026-05-05T00:00:00Z',
  });

  const response = await handleReviewMeditationGroupJoin(
    new Request('https://flutter.ombhrum.com/api/meditation/groups/review', {
      method: 'POST',
      headers: {
        Authorization: authHeader('owner2'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        groupId: 11,
        username: 'applicant',
        approve: true,
      }),
    }),
    {},
    db,
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(members.get(keyFor(11, 'owner2')).status, 'active');
  assert.equal(members.get(keyFor(11, 'applicant')).status, 'active');
});

test('group list supports owner search and exposes pending approvals to the owner', async () => {
  const { db, groups, members, keyFor } = createDbMock();
  groups.set(21, {
    id: 21,
    owner_username: 'group-owner',
    owner_nickname: '禅修发起人',
    name: '晨光共修',
    description: '每天一起完成早课',
    require_approval: 1,
    daily_goal_minutes: 20,
    cumulative_miss_limit: 5,
    consecutive_miss_limit: 2,
    created_at: '2026-05-05T00:00:00Z',
  });
  members.set(keyFor(21, 'group-owner'), {
    id: 9,
    group_id: 21,
    username: 'group-owner',
    role: 'owner',
    status: 'active',
    joined_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-05T00:00:00Z',
  });
  members.set(keyFor(21, 'pending-a'), {
    id: 10,
    group_id: 21,
    username: 'pending-a',
    role: 'member',
    status: 'pending',
    joined_at: '2026-05-05T00:00:00Z',
    updated_at: '2026-05-05T00:00:00Z',
  });
  members.set(keyFor(21, 'pending-b'), {
    id: 11,
    group_id: 21,
    username: 'pending-b',
    role: 'member',
    status: 'pending',
    joined_at: '2026-05-05T00:00:00Z',
    updated_at: '2026-05-05T00:00:00Z',
  });

  const response = await handleGetMeditationGroups(
    new Request('https://flutter.ombhrum.com/api/meditation/groups?query=%E7%A6%85%E4%BF%AE%E5%8F%91%E8%B5%B7%E4%BA%BA', {
      headers: { Authorization: authHeader('group-owner') },
    }),
    {},
    db,
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.groups.length, 1);
  assert.equal(payload.data.groups[0].ownerName, '禅修发起人');
  assert.equal(payload.data.groups[0].pendingCount, 2);
  assert.equal(payload.data.groups[0].myRole, 'owner');
});

test('group list also supports searching by visible group id token', async () => {
  const { db, groups, members, keyFor } = createDbMock();
  groups.set(35, {
    id: 35,
    owner_username: 'owner-35',
    owner_nickname: '晚课组织者',
    name: '莲灯晚课',
    description: '晚间共修',
    require_approval: 1,
    daily_goal_minutes: 25,
    cumulative_miss_limit: 5,
    consecutive_miss_limit: 2,
    created_at: '2026-05-05T00:00:00Z',
  });
  members.set(keyFor(35, 'searcher'), {
    id: 12,
    group_id: 35,
    username: 'searcher',
    role: 'member',
    status: 'removed',
    joined_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-05T00:00:00Z',
  });

  const response = await handleGetMeditationGroups(
    new Request('https://flutter.ombhrum.com/api/meditation/groups?query=%2335', {
      headers: { Authorization: authHeader('searcher') },
    }),
    {},
    db,
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.groups.length, 1);
  assert.equal(payload.data.groups[0].id, 35);
  assert.equal(payload.data.groups[0].name, '莲灯晚课');
});