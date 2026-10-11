import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  handleCreateHumanCallMediaSession,
  handleGetHumanCallMembers,
  handleMutateHumanCallMember,
} from '../src/handlers/call-signaling.js';

const handler = fs.readFileSync(new URL('../src/handlers/call-signaling.js', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../src/routes/community-routes.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/20261012_human_call_group_membership.sql', import.meta.url), 'utf8');
const mediaMigration = fs.readFileSync(new URL('../migrations/20261012_human_call_sfu_sessions.sql', import.meta.url), 'utf8');
const spec = fs.readFileSync(new URL('../../../docs/specs/human-call-signaling.md', import.meta.url), 'utf8');

test('group membership handlers are executable exports and stay on canonical call owner', () => {
  assert.equal(typeof handleGetHumanCallMembers, 'function');
  assert.equal(typeof handleMutateHumanCallMember, 'function');
  assert.ok(routes.includes('/api/social/calls'));
  assert.ok(routes.includes('/members'));
  assert.match(handler, /human_call_members/);
  assert.match(handler, /human_call_member_mutations/);
  assert.match(handler, /membership_revision/);
  assert.ok((handler.match(/membership_revision/g) || []).length >= 8, 'canonical call reads must project membership revision');
  assert.match(handler, /expectedMembershipRevision/);
  assert.match(handler, /generation !== Number\(call\.generation\)/);
  assert.match(handler, /creator_device_id/);
  assert.match(handler, /MEMBER_ACTIONS/);
  assert.match(handler, /Number\(target\.id\) === Number\(call\.peer_user_id\)/);
  assert.match(spec, /legacy `peer_user_id` participant cannot be removed/);
  assert.doesNotMatch(handler, /InsecureSkipVerify|go_sfu|raw-TCP/i);
});

test('migration durably backfills creator and peer without a second call store', () => {
  assert.match(migration, /ALTER TABLE human_call_channels[\s\S]*membership_revision/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS human_call_members/);
  assert.match(migration, /PRIMARY KEY \(call_id, user_id\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS human_call_member_mutations/);
  assert.match(migration, /client_mutation_id/);
  assert.match(migration, /SELECT id, creator_user_id, 'creator', 'active'/);
  assert.match(migration, /SELECT id, peer_user_id, 'member', 'active'/);
  assert.doesNotMatch(migration, /CREATE TABLE[^;]*(telegram|sfu_call|group_call_channels)/i);
});

test('spec keeps real SFU media routing fail-closed and outside this roster increment', () => {
  assert.match(spec, /Group\/SFU existing-owner extension/);
  assert.match(spec, /short-lived account\/device-scoped lease/);
  assert.match(spec, /real production SFU provider\/session API is configured/);
  assert.match(spec, /MUST fail closed rather than returning fake routes/);
  assert.match(spec, />=3 participant production E2E/);
});

test('SFU session allocation is backend-owned, durable, and fail-closed on uncertain outcomes', () => {
  assert.equal(typeof handleCreateHumanCallMediaSession, 'function');
  assert.ok(routes.includes('/media'));
  assert.ok(routes.includes('/sessions'));
  assert.match(handler, /FABUSHI_REALTIME_SFU_APP_ID/);
  assert.match(handler, /FABUSHI_REALTIME_SFU_APP_SECRET/);
  assert.match(handler, /human_call_media_sessions/);
  assert.match(handler, /status === 'pending' \|\| existing\.status === 'uncertain'/);
  assert.match(handler, /network_outcome_unknown/);
  assert.match(handler, /禁止自动重试/);
  assert.match(handler, /\/sessions\/new\?correlationId=/);
  assert.match(handler, /Authorization: `Bearer \$\{config\.appSecret\}`/);
  assert.doesNotMatch(handler, /appSecret[^\n]*jsonResponse/);
  assert.match(mediaMigration, /UNIQUE \(call_id, user_id, device_id, client_session_id\)/);
  assert.match(mediaMigration, /provider_session_id TEXT UNIQUE/);
  assert.match(mediaMigration, /'pending', 'ready', 'uncertain', 'failed', 'closed'/);
  assert.match(spec, /provider `sessionId` is backend-private/);
  assert.match(spec, /MUST NOT issue another provider allocation/);
});

