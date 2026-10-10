import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STORY_STEALTH_ACTIVE_MS,
  STORY_STEALTH_COOLDOWN_MS,
  STORY_STEALTH_RETROACTIVE_MS,
  activateStoryStealthForAuth,
  normalizeStoryForServer,
  storyActorIdFromAccountId,
} from '../src/handlers/stories.js';

function createStealthDb({
  user = {
    id: 42,
    username: 'alice',
    membership_type: 'lifetime',
    membership_expires_at: null,
    free_trial_end_date: null,
  },
  stealth = null,
  recentViews = [],
} = {}) {
  let stealthRow = stealth ? { user_id: user.id, ...stealth } : null;
  const views = recentViews.map((entry) => ({ ...entry }));
  const anonymous = new Map();
  return {
    state: { get stealth() { return stealthRow; }, views, anonymous },
    prepare(sql) {
      const query = sql.replace(/\s+/g, ' ').trim();
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async first() {
          if (query.includes('FROM users') && query.includes('WHERE id = ?')) {
            return Number(params[0]) === user.id ? { ...user } : null;
          }
          if (query.includes('FROM story_stealth')) {
            return Number(params[0]) === user.id && stealthRow ? { ...stealthRow } : null;
          }
          return null;
        },
        async all() {
          if (query.includes('FROM story_views') && query.includes('GROUP BY story_id')) {
            const [viewerUserId, sinceMs] = params;
            const counts = new Map();
            for (const view of views) {
              if (view.viewer_user_id === Number(viewerUserId) && view.viewed_at_ms >= Number(sinceMs)) {
                counts.set(view.story_id, (counts.get(view.story_id) || 0) + 1);
              }
            }
            return {
              results: [...counts].map(([story_id, removed_count]) => ({ story_id, removed_count })),
            };
          }
          return { results: [] };
        },
        async run() {
          if (query.startsWith('INSERT INTO story_stealth')) {
            if (!stealthRow) {
              stealthRow = {
                user_id: Number(params[0]),
                enabled_till_ms: 0,
                cooldown_till_ms: 0,
                last_activation_request_id: null,
                updated_at_ms: Number(params[1]),
              };
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (query.startsWith('UPDATE story_stealth')) {
            const [enabled, cooldown, requestId, updatedAt, userId, enabledGate, cooldownGate] = params;
            if (
              stealthRow
              && stealthRow.user_id === Number(userId)
              && Number(stealthRow.enabled_till_ms || 0) <= Number(enabledGate)
              && Number(stealthRow.cooldown_till_ms || 0) <= Number(cooldownGate)
            ) {
              stealthRow = {
                ...stealthRow,
                enabled_till_ms: Number(enabled),
                cooldown_till_ms: Number(cooldown),
                last_activation_request_id: requestId,
                updated_at_ms: Number(updatedAt),
              };
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (query.startsWith('DELETE FROM story_views')) {
            const [viewerUserId, sinceMs] = params;
            for (let index = views.length - 1; index >= 0; index -= 1) {
              if (views[index].viewer_user_id === Number(viewerUserId)
                  && views[index].viewed_at_ms >= Number(sinceMs)) {
                views.splice(index, 1);
              }
            }
            return { meta: { changes: 1 } };
          }
          if (query.startsWith('UPDATE stories') && query.includes('anonymous_view_count')) {
            const [count, storyId] = params;
            anonymous.set(storyId, (anonymous.get(storyId) || 0) + Number(count));
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
    },
  };
}

test('Story account actor id matches Desktop sha256 fingerprint contract', async () => {
  const actor = await storyActorIdFromAccountId('197915874789377');
  assert.match(actor, /^human:account:[0-9a-f]{32}$/);
  assert.equal(actor, await storyActorIdFromAccountId('197915874789377'));
  assert.notEqual(actor, await storyActorIdFromAccountId('197915874789378'));
});

test('server normalizes Story ownership and rejects spoofed owner', async () => {
  const actor = await storyActorIdFromAccountId(42);
  const normalized = normalizeStoryForServer({
    id: 'story:42:1',
    ownerId: 'human:account:spoofed',
    media: { id: 'media:1', kind: 'image' },
    caption: { text: 'caption', entities: [] },
    privacy: { kind: 'everyone', includedActorIds: [], excludedActorIds: [] },
    createdAtMs: 100,
    expiresAtMs: 1000,
    pinnedToProfile: false,
    protectedContent: false,
    allowReplies: true,
  }, actor);
  assert.equal(normalized.ownerId, actor);
  assert.deepEqual(normalized.views, {});
  assert.equal(normalized.anonymousViewCount, 0);
});

test('stealth activation is entitled, idempotent and server-authoritative', async () => {
  const nowMs = 10_000_000;
  const db = createStealthDb({
    recentViews: [
      { story_id: 'story:a', viewer_user_id: 42, viewed_at_ms: nowMs - 1_000 },
      { story_id: 'story:b', viewer_user_id: 42, viewed_at_ms: nowMs - STORY_STEALTH_RETROACTIVE_MS - 1 },
    ],
  });
  const auth = { userId: 42, username: 'alice' };
  const first = await activateStoryStealthForAuth(db, auth, {}, { requestId: 'req-1', nowMs });
  assert.equal(first.status, 200);
  assert.equal(first.payload.deduplicated, false);
  assert.equal(first.payload.state.enabledTillMs, nowMs + STORY_STEALTH_ACTIVE_MS);
  assert.equal(first.payload.state.cooldownTillMs, nowMs + STORY_STEALTH_COOLDOWN_MS);
  assert.equal(first.payload.anonymizedRecentViews, 1);
  assert.equal(db.state.anonymous.get('story:a'), 1);
  assert.equal(db.state.views.length, 1);

  const retry = await activateStoryStealthForAuth(db, auth, {}, { requestId: 'req-1', nowMs: nowMs + 50 });
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.deduplicated, true);
  assert.equal(retry.payload.state.enabledTillMs, first.payload.state.enabledTillMs);
});

test('stealth rejects unentitled accounts and enforces cooldown', async () => {
  const nowMs = 20_000_000;
  const freeDb = createStealthDb({
    user: {
      id: 42,
      username: 'alice',
      membership_type: 'free',
      membership_expires_at: null,
      free_trial_end_date: new Date(nowMs - 1).toISOString(),
    },
  });
  const auth = { userId: 42, username: 'alice' };
  const denied = await activateStoryStealthForAuth(freeDb, auth, {}, { requestId: 'free-1', nowMs });
  assert.equal(denied.status, 403);

  const coolingDb = createStealthDb({
    stealth: {
      enabled_till_ms: nowMs - 1,
      cooldown_till_ms: nowMs + 5_000,
      last_activation_request_id: 'old',
      updated_at_ms: nowMs - 10_000,
    },
  });
  const cooling = await activateStoryStealthForAuth(coolingDb, auth, {}, { requestId: 'new', nowMs });
  assert.equal(cooling.status, 409);
  assert.equal(cooling.payload.retryAtMs, nowMs + 5_000);
});
