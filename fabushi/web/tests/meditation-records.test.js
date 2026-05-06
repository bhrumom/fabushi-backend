import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleUpdateRecord,
  handleDeleteRecord,
} from '../src/handlers/meditation.js';

function authHeader(username) {
  const payload = Buffer.from(JSON.stringify({ username })).toString('base64url');
  return `Bearer header.${payload}.signature`;
}

function createDbMock() {
  const records = new Map();
  const goals = new Map();

  const db = {
    prepare(sql) {
      const normalizedSql = sql.trim().replace(/\s+/g, ' ');

      return {
        bind(...params) {
          return {
            async first() {
              if (normalizedSql.startsWith('SELECT COALESCE(MAX(sync_version), 0) + 1 as next_version FROM (')) {
                const username = params[0];
                const recordVersions = Array.from(records.values())
                    .filter((record) => record.username === username)
                    .map((record) => record.sync_version || 0);
                const goalVersions = Array.from(goals.values())
                    .filter((goal) => goal.username === username)
                    .map((goal) => goal.sync_version || 0);
                const maxVersion = Math.max(0, ...recordVersions, ...goalVersions);
                return { next_version: maxVersion + 1 };
              }

              if (normalizedSql.startsWith('SELECT id, sutra_name, sutra_source, duration, chant_count, record_date,')) {
                const record = records.get(params[0]);
                if (!record || record.username !== params[1]) return null;
                return { ...record };
              }

              if (normalizedSql.startsWith('SELECT id, sutra_name, chant_count FROM meditation_records WHERE id = ? AND username = ?')) {
                const record = records.get(params[0]);
                if (!record || record.username !== params[1]) return null;
                return {
                  id: record.id,
                  sutra_name: record.sutra_name,
                  chant_count: record.chant_count,
                };
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

              return { results: [] };
            },
            async run() {
              if (normalizedSql.startsWith('UPDATE meditation_records SET sutra_name = ?,')) {
                const [
                  sutraName,
                  sutraSource,
                  duration,
                  chantCount,
                  recordDate,
                  localTime,
                  timezoneOffsetMinutes,
                  startTime,
                  endTime,
                  isManual,
                  notes,
                  syncVersion,
                  recordId,
                  username,
                ] = params;
                const record = records.get(recordId);
                if (!record || record.username !== username) return;
                Object.assign(record, {
                  sutra_name: sutraName,
                  sutra_source: sutraSource,
                  duration,
                  chant_count: chantCount,
                  record_date: recordDate,
                  local_time: localTime,
                  timezone_offset_minutes: timezoneOffsetMinutes,
                  start_time: startTime,
                  end_time: endTime,
                  is_manual: isManual,
                  notes,
                  sync_version: syncVersion,
                });
                return;
              }

              if (normalizedSql.startsWith('UPDATE meditation_goals SET current_count = CASE')) {
                const [delta, , updatedAt, syncVersion, username, sutraName] = params;
                const key = `${username}:${sutraName}`;
                const goal = goals.get(key);
                if (!goal || goal.status !== 'active') return;
                goal.current_count = Math.max(0, goal.current_count + delta);
                goal.updated_at = updatedAt;
                goal.sync_version = syncVersion;
                return;
              }

              if (normalizedSql.startsWith('DELETE FROM meditation_records WHERE id = ? AND username = ?')) {
                const [recordId, username] = params;
                const record = records.get(recordId);
                if (record && record.username === username) {
                  records.delete(recordId);
                }
              }
            },
          };
        },
      };
    },
  };

  return { db, records, goals };
}

function createEnv() {
  const deletedKeys = [];
  return {
    deletedKeys,
    USERS_KV: {
      async delete(key) {
        deletedKeys.push(key);
      },
    },
  };
}

test('updating a record with a new sutra moves goal progress and clears caches', async () => {
  const { db, records, goals } = createDbMock();
  const env = createEnv();

  records.set(7, {
    id: 7,
    username: 'bhrum108',
    sutra_name: '心经',
    sutra_source: 'custom',
    duration: 30,
    chant_count: 2,
    record_date: '2026-05-06',
    local_time: '08:00',
    timezone_offset_minutes: 480,
    start_time: null,
    end_time: null,
    is_manual: 1,
    notes: '旧心得',
    sync_version: 3,
  });
  goals.set('bhrum108:心经', {
    username: 'bhrum108',
    sutra_name: '心经',
    current_count: 10,
    status: 'active',
    sync_version: 2,
  });
  goals.set('bhrum108:金刚经', {
    username: 'bhrum108',
    sutra_name: '金刚经',
    current_count: 4,
    status: 'active',
    sync_version: 2,
  });

  const response = await handleUpdateRecord(
    new Request('https://flutter.ombhrum.com/api/meditation/records?id=7', {
      method: 'PUT',
      headers: {
        Authorization: authHeader('bhrum108'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sutra: '金刚经',
        sutraSource: 'custom',
        chantCount: 5,
        duration: 45,
        recordDate: '2026-05-06',
        localTime: '09:30',
        notes: '补充后的心得',
        isManual: true,
      }),
    }),
    env,
    db,
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(records.get(7)?.sutra_name, '金刚经');
  assert.equal(records.get(7)?.chant_count, 5);
  assert.equal(records.get(7)?.duration, 45);
  assert.equal(records.get(7)?.notes, '补充后的心得');
  assert.equal(goals.get('bhrum108:心经')?.current_count, 8);
  assert.equal(goals.get('bhrum108:金刚经')?.current_count, 9);
  assert.deepEqual(env.deletedKeys.sort(), [
    'leaderboard:cache',
    'leaderboard:cache:v2',
    'leaderboard:practice:v2',
    'leaderboard:practice:v3',
    'leaderboard:practice:v4',
  ]);
});

test('deleting a record removes it and rolls back goal progress', async () => {
  const { db, records, goals } = createDbMock();
  const env = createEnv();

  records.set(9, {
    id: 9,
    username: 'bhrum108',
    sutra_name: '药师经',
    sutra_source: 'custom',
    duration: 20,
    chant_count: 3,
    record_date: '2026-05-05',
    local_time: '21:00',
    timezone_offset_minutes: 480,
    start_time: null,
    end_time: null,
    is_manual: 1,
    notes: '',
    sync_version: 6,
  });
  goals.set('bhrum108:药师经', {
    username: 'bhrum108',
    sutra_name: '药师经',
    current_count: 3,
    status: 'active',
    sync_version: 5,
  });

  const response = await handleDeleteRecord(
    new Request('https://flutter.ombhrum.com/api/meditation/records?id=9', {
      method: 'DELETE',
      headers: {
        Authorization: authHeader('bhrum108'),
      },
    }),
    env,
    db,
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(records.has(9), false);
  assert.equal(goals.get('bhrum108:药师经')?.current_count, 0);
  assert.equal(env.deletedKeys.includes('leaderboard:practice:v4'), true);
});
