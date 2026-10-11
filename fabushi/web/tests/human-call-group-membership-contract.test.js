import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  handleGetHumanCallMembers,
  handleMutateHumanCallMember,
} from '../src/handlers/call-signaling.js';

const handler = fs.readFileSync(new URL('../src/handlers/call-signaling.js', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../src/routes/community-routes.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/20261012_human_call_group_membership.sql', import.meta.url), 'utf8');
const spec = fs.readFileSync(new URL('../../../docs/specs/human-call-signaling.md', import.meta.url), 'utf8');

test('group membership handlers are executable exports and stay on canonical call owner', () => {
  assert.equal(typeof handleGetHumanCallMembers, 'function');
  assert.equal(typeof handleMutateHumanCallMember, 'function');
  assert.match(routes, /api\\/social\\/calls.*members/);
  assert.match(handler, /human_call_members/);
  assert.match(handler, /human_call_member_mutations/);
  assert.match(handler, /membership_revision/);
  assert.match(handler, /expectedMembershipRevision/);
  assert.match(handler, /generation !== Number\(call\.generation\)/);
  assert.match(handler, /creator_device_id/);
  assert.match(handler, /MEMBER_ACTIONS/);
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
