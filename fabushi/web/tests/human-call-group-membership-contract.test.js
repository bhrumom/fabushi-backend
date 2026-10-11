import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  handleCreateHumanCallMediaSession,
  handlePublishHumanCallMedia,
  handleAcknowledgeHumanCallMediaOperationApplied,
  handleDiscoverHumanCallMediaPublications,
  handleSubscribeHumanCallMedia,
  handleAnswerHumanCallMediaSubscription,
  handleCloseHumanCallMediaSession,
  handleUpdateHumanCallMediaSubscriptionLayer,
  handleGetHumanCallMembers,
  handleMutateHumanCallMember,
} from '../src/handlers/call-signaling.js';

const handler = fs.readFileSync(new URL('../src/handlers/call-signaling.js', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../src/routes/community-routes.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/20261012_human_call_group_membership.sql', import.meta.url), 'utf8');
const mediaMigration = fs.readFileSync(new URL('../migrations/20261012_human_call_sfu_sessions.sql', import.meta.url), 'utf8');
const publicationMigration = fs.readFileSync(new URL('../migrations/20261013_human_call_sfu_publications.sql', import.meta.url), 'utf8');
const subscriptionMigration = fs.readFileSync(new URL('../migrations/20261014_human_call_sfu_subscriptions.sql', import.meta.url), 'utf8');
const teardownMigration = fs.readFileSync(new URL('../migrations/20261015_human_call_sfu_teardowns.sql', import.meta.url), 'utf8');
const simulcastMigration = fs.readFileSync(new URL('../migrations/20261016_human_call_sfu_simulcast.sql', import.meta.url), 'utf8');
const layerMutationMigration = fs.readFileSync(new URL('../migrations/20261017_human_call_sfu_layer_mutations.sql', import.meta.url), 'utf8');
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
  assert.match(handler, /JOIN human_call_members m/);
  assert.match(handler, /m\.state = 'active'/);
  assert.doesNotMatch(handler, /Number\(target\.id\) === Number\(call\.peer_user_id\)/);
  assert.match(handler, /'creator', 'active'/);
  assert.match(handler, /'member', 'active'/);
  assert.match(spec, /creator\/peer columns remain compatibility metadata, not authorization bypasses/);
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



test('SFU publication mutations are durable, serialized, partial-result aware, and endpoint-applied fenced', () => {
  assert.equal(typeof handlePublishHumanCallMedia, 'function');
  assert.equal(typeof handleAcknowledgeHumanCallMediaOperationApplied, 'function');
  assert.ok(routes.includes('/publications'));
  assert.match(routes, /operations\\\//);
  assert.ok(routes.includes('/applied'));
  assert.match(handler, /human_call_media_operations/);
  assert.match(handler, /human_call_media_publications/);
  assert.match(handler, /request_fingerprint/);
  assert.match(handler, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(handler, /mutation_state = 'mutating'/);
  assert.match(handler, /mutation_state = 'awaiting_endpoint_apply'/);
  assert.match(handler, /mutation_state = 'retired'/);
  assert.match(handler, /network_outcome_unknown/);
  assert.match(handler, /provider_result_incomplete/);
  assert.match(handler, /provider_answer_missing/);
  assert.match(handler, /\/tracks\/new/);
  assert.match(handler, /location: 'local'/);
  assert.match(handler, /status: 'awaiting_endpoint_apply'/);
  assert.match(handler, /status = 'applied'/);
  assert.match(handler, /response_session_description_json = NULL/);
  assert.match(publicationMigration, /ADD COLUMN mutation_state/);
  assert.match(publicationMigration, /CREATE TABLE IF NOT EXISTS human_call_media_operations/);
  assert.match(publicationMigration, /UNIQUE \(media_session_id, client_operation_id\)/);
  assert.match(publicationMigration, /CREATE TABLE IF NOT EXISTS human_call_media_publications/);
  assert.match(publicationMigration, /UNIQUE \(media_session_id, client_publication_id\)/);
  assert.match(publicationMigration, /UNIQUE \(media_session_id, track_name\)/);
  assert.match(spec, /A partially successful batch is never replayed as a whole/);
  assert.match(spec, /awaiting_endpoint_apply/);
  assert.doesNotMatch(handler, /provider_session_id[^\n]*jsonResponse/);
  assert.doesNotMatch(handler, /appSecret[^\n]*jsonResponse/);
});


test('new calls create active canonical roster and group members use roster-owned device authorization', () => {
  assert.match(handler, /INSERT INTO human_call_channels[\s\S]*'invited', 0, 0, 0, NULL/);
  assert.match(handler, /INSERT INTO human_call_members[\s\S]*'creator', 'active'/);
  assert.match(handler, /INSERT INTO human_call_members[\s\S]*'member', 'active'/);
  assert.match(handler, /rosterMember = await readCallMember/);
  assert.match(handler, /rosterMember\.device_id/);
  assert.match(handler, /JOIN human_call_members m[\s\S]*m\.user_id = \?[\s\S]*m\.state = 'active'/);
});


test('SFU publication discovery and remote subscription stay authorized and provider-private', () => {
  assert.equal(typeof handleDiscoverHumanCallMediaPublications, 'function');
  assert.equal(typeof handleSubscribeHumanCallMedia, 'function');
  assert.equal(typeof handleAnswerHumanCallMediaSubscription, 'function');
  assert.match(routes, /media\\\/publications/);
  assert.match(routes, /subscriptions/);
  assert.match(routes, /operations\\\/.*answer/);
  assert.match(handler, /operation_kind/);
  assert.match(handler, /human_call_media_subscriptions/);
  assert.match(handler, /location: 'remote'/);
  assert.match(handler, /sessionId: publication\.provider_session_id/);
  assert.match(handler, /\/renegotiate/);
  assert.match(handler, /subscription_network_outcome_unknown/);
  assert.match(handler, /subscription_result_incomplete/);
  assert.match(handler, /subscription_offer_missing/);
  assert.match(handler, /renegotiate_outcome_unknown/);
  assert.match(handler, /JOIN human_call_members m/);
  assert.match(subscriptionMigration, /ADD COLUMN operation_kind/);
  assert.match(subscriptionMigration, /CHECK \(operation_kind IN \('publish', 'subscribe'\)\)/);
  assert.match(subscriptionMigration, /CREATE TABLE IF NOT EXISTS human_call_media_subscriptions/);
  assert.match(subscriptionMigration, /UNIQUE \(media_session_id, publication_id\)/);
  assert.match(spec, /Publication discovery/);
  assert.match(spec, /Directed subscription/);
  assert.match(spec, /\/renegotiate/);
  assert.doesNotMatch(handler, /provider_session_id[^\n]*jsonResponse/);
  assert.doesNotMatch(handler, /appSecret[^\n]*jsonResponse/);
});


test('SFU teardown is durable, idempotent, partial-result aware, and generation-local', () => {
  assert.equal(typeof handleCloseHumanCallMediaSession, 'function');
  assert.match(routes, /media\\\/sessions\\\/.*close/);
  assert.match(handler, /human_call_media_teardowns/);
  assert.match(handler, /clientTeardownId/);
  assert.match(handler, /requestFingerprint/);
  assert.match(handler, /readClosableMediaTracks/);
  assert.match(handler, /\/tracks\/close/);
  assert.match(handler, /force: true/);
  assert.match(handler, /track_close_network_outcome_unknown/);
  assert.match(handler, /track_close_persist_conflict/);
  assert.match(handler, /errorCode !== 'close_track_error'/);
  assert.match(handler, /reconciliation: 'already_absent'/);
  assert.match(handler, /mutation_state = 'retired'/);
  assert.match(handler, /status === 'closed'/);
  assert.match(handler, /\['ready', 'uncertain'\]\.includes\(mediaSession\.status\)/);
  assert.match(teardownMigration, /CREATE TABLE IF NOT EXISTS human_call_media_teardowns/);
  assert.match(teardownMigration, /UNIQUE \(media_session_id, client_teardown_id\)/);
  assert.match(teardownMigration, /'pending', 'applied', 'uncertain', 'failed'/);
  assert.match(spec, /session-local track teardown/);
  assert.match(spec, /partial close results/);
  assert.match(spec, /never automatically replayed/);
  assert.doesNotMatch(handler, /provider_session_id[^\n]*jsonResponse/);
  assert.doesNotMatch(handler, /appSecret[^\n]*jsonResponse/);
});


test('SFU simulcast publication and subscription layer policy stays application-owned', () => {
  assert.match(handler, /simulcastRids/);
  assert.match(handler, /sdpAdvertisesSimulcastRids/);
  assert.match(handler, /a=simulcast:send/);
  assert.match(handler, /a=rid:/);
  assert.match(handler, /preferredRid/);
  assert.match(handler, /priorityOrdering/);
  assert.match(handler, /ridNotAvailable/);
  assert.match(handler, /simulcast_rids_json/);
  assert.match(handler, /请求的 simulcast layer 未由该发布广告/);
  assert.match(handler, /\.\.\.\(simulcast \? \{ simulcast \} : \{\}\)/);
  assert.match(simulcastMigration, /ADD COLUMN simulcast_rids_json TEXT/);
  assert.match(simulcastMigration, /ADD COLUMN preferred_rid TEXT/);
  assert.match(simulcastMigration, /'none', 'asciibetical'/);
  assert.match(spec, /available RIDs/);
  assert.match(spec, /preferredRid/);
  assert.doesNotMatch(handler, /provider_session_id[^\n]*jsonResponse/);
  assert.doesNotMatch(handler, /appSecret[^\n]*jsonResponse/);
});


test('SFU dynamic simulcast layer switching is durable and unknown-outcome fenced', () => {
  assert.equal(typeof handleUpdateHumanCallMediaSubscriptionLayer, 'function');
  assert.match(routes, /subscriptions\\\/.*layer/);
  assert.match(handler, /human_call_media_layer_mutations/);
  assert.match(handler, /clientMutationId/);
  assert.match(handler, /requestFingerprint/);
  assert.match(handler, /\/tracks\/update/);
  assert.match(handler, /location: 'remote'/);
  assert.match(handler, /mid: subscription\.receive_mid/);
  assert.match(handler, /sessionId: subscription\.publisher_provider_session_id/);
  assert.match(handler, /trackName: subscription\.track_name/);
  assert.match(handler, /requiresImmediateRenegotiation/);
  assert.match(handler, /layer_update_network_outcome_unknown/);
  assert.match(handler, /layer_update_result_identity_mismatch/);
  assert.match(handler, /layer_update_unexpected_renegotiation/);
  assert.match(handler, /status = 'uncertain', mutation_state = 'retired'/);
  assert.match(layerMutationMigration, /CREATE TABLE IF NOT EXISTS human_call_media_layer_mutations/);
  assert.match(layerMutationMigration, /UNIQUE \(media_session_id, client_mutation_id\)/);
  assert.match(layerMutationMigration, /'pending', 'applied', 'uncertain', 'failed'/);
  assert.match(spec, /tracks\/update/);
  assert.match(spec, /layer mutation/);
  assert.doesNotMatch(handler, /provider_session_id[^\n]*jsonResponse/);
  assert.doesNotMatch(handler, /appSecret[^\n]*jsonResponse/);
});


test('reconnect, terminal transitions, and member removal durably retire stale media generations', () => {
  assert.match(handler, /retireMediaSessionsForLifecycleStatement/);
  assert.match(handler, /generation_retired_cleanup_required/);
  assert.match(handler, /call_terminal_cleanup_required/);
  assert.match(handler, /member_removed_cleanup_required/);
  assert.match(handler, /status = 'uncertain', mutation_state = 'retired'/);
  assert.match(handler, /status IN \('pending', 'ready', 'uncertain'\)/);
  assert.match(handler, /generation: Number\(call\.generation\)/);
  assert.match(handler, /userId: Number\(target\.id\)/);
  assert.match(handler, /mediaCleanup/);
  assert.match(handler, /retiredSessionCount/);
  assert.match(handler, /results\.slice\(0, 3\)/);
  assert.match(spec, /generation\/reconnect retirement/);
  assert.match(spec, /member removal retirement/);
  assert.match(spec, /provider resources are not claimed closed/);
});
