import test from 'node:test';
import assert from 'node:assert/strict';

import { generateToken } from '../auth-utils.js';
import { route } from '../src/router.js';

const TEST_ENV = { JWT_SECRET: 'test-secret' };

function createDbMock() {
  return {
    prepare(sql) {
      const normalizedSql = sql.trim().replace(/\s+/g, ' ');
      return {
        bind(...params) {
          return {
            async all() {
              if (normalizedSql.startsWith('SELECT id, sutra_name, target_count, current_count, dedication, status, created_at, completed_at FROM meditation_goals WHERE username = ? AND status = ? ORDER BY created_at DESC')) {
                assert.equal(params[0], 'meditator');
                assert.equal(params[1], 'active');
                return {
                  results: [
                    {
                      id: 1,
                      sutra_name: '心经',
                      target_count: 108,
                      current_count: 12,
                      dedication: '回向众生',
                      status: 'active',
                      created_at: '2026-05-01T00:00:00Z',
                      completed_at: null,
                    },
                  ],
                };
              }
              return { results: [] };
            },
            async first() {
              return null;
            },
            async run() {
              return null;
            },
          };
        },
      };
    },
  };
}

test('router accepts signed JWTs on meditation endpoints by normalizing them for legacy handlers', async () => {
  const token = await generateToken('meditator', TEST_ENV);
  const response = await route(
    new Request('https://flutter.ombhrum.com/api/meditation/goal?status=active', {
      headers: { Authorization: `Bearer ${token}` },
    }),
    TEST_ENV,
    createDbMock(),
    {},
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.goals.length, 1);
  assert.equal(payload.data.goals[0].sutra_name, '心经');
  assert.equal(payload.data.goals[0].progress, 11);
});

test('router rejects invalid signed JWTs before legacy meditation handlers can accept them', async () => {
  const token = await generateToken('meditator', TEST_ENV);
  const [header, payload, signature] = token.split('.');
  const tamperedSignature = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
  const tampered = `${header}.${payload}.${tamperedSignature}`;
  const response = await route(
    new Request('https://flutter.ombhrum.com/api/meditation/goal?status=active', {
      headers: { Authorization: `Bearer ${tampered}` },
    }),
    TEST_ENV,
    createDbMock(),
    {},
  );

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.match(body.error, /认证失败/);
});
