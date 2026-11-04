# Fabushi Human Direct Messaging Extensions — Specification

Status: active
Owner: Fabushi Backend / Social Messaging
Last updated: 2026-11-02
Related issue/task/PR: Fabushi Desktop FBCP Phase 1 / desktop PR #27

## 1. Context / problem

Fabushi Desktop Phase 1 absorbs Telegram Desktop communication capabilities into Fabushi's existing Human + Agent product. The existing backend already owns authenticated friends and durable one-to-one `direct_messages` through `/api/social/messages`, including account authorization and `clientRequestId` idempotency. It does not yet carry reply relations, message resources, reactions, incremental reconnect cursors, or message search. Desktop must not substitute local-only state for those cross-device responsibilities.

## 2. Goal

Extend the existing social direct-message owner so Fabushi clients can durably send, synchronize, search and react to Human messages across devices while preserving one canonical backend message truth and allowing Desktop Host Session/Transcript to remain a local materialized product owner.

## 3. Non-goals / out of scope

- No Telegram/MTProto provider or Telegram identity.
- No second communication/message database outside the existing social messaging domain.
- No group/channel/call/presence protocol in this change.
- No arbitrary URL or Desktop-local-path attachment references.
- No end-to-end encryption redesign in this increment.
- No unauthenticated/public access to private message resources.

## 4. Requirements

- R1: `direct_messages` remains the canonical durable one-to-one Human message record and existing friendship/account authorization remains mandatory.
- R2: POST `/api/social/messages` keeps sender-scoped `clientRequestId` idempotency and accepts optional `replyToMessageId` only when the target belongs to the same authorized peer pair.
- R3: Messages may reference zero or more server-owned message resources; clients may not persist local filesystem paths or arbitrary external URLs as message resources.
- R4: Authenticated users may upload bounded message resources to the existing R2 infrastructure. A resource is owned by the uploader until referenced by a message, and reads require resource ownership or participation in a message that references the resource.
- R5: Reactions are normalized relations keyed by message, reacting user, and emoji; only conversation participants may read/change reactions.
- R6: GET `/api/social/messages` supports bounded history via existing `before`, incremental reconnect via `afterId`, and case-insensitive text search via `q`; these filters must remain scoped to the authenticated peer pair.
- R7: Message responses include `replyToMessageId`, canonical resource metadata, and reaction summaries without exposing storage credentials or object keys.
- R8: Cross-device semantics distinguish account identity from `x-fabushi-device-id`; device identity may be used for observability but cannot become message ownership truth.
- R9: Existing plain-text clients remain compatible.
- R10: Server validation fails closed for foreign reply targets, foreign resources, non-friends, malformed reactions, oversized text/resources, and missing R2 bindings for upload/download.
- R11: A sender may edit an existing non-deleted direct message without changing its canonical message ID. Each mutation carries a unique `operationId` plus `expectedRevision`; successful edits increment a monotonic `revision`, set `editedAt`, and preserve reply/resource/reaction identity unless explicitly changed by another typed capability.
- R12: A sender may delete an existing direct message as a tombstone mutation. Delete preserves the canonical message row/ID for reply provenance and synchronization, increments `revision`, records `deletedAt`, clears message body and attachment references, and removes reactions. Recipients cannot edit/delete another sender's message.
- R13: Mutation retries are idempotent by `operationId`. Reusing an operation ID for a different message/kind/payload is rejected; stale `expectedRevision` is rejected with HTTP 409 and the current canonical message so clients can reconcile instead of minting a replacement.
- R14: An explicit `afterId=0` starts a complete, bounded traversal of the authorized pair in ascending message-ID order. Accept only decimal non-negative safe integers; reject negative, fractional, non-decimal, non-numeric and unsafe values. Preserve the existing `before`/`afterId` exclusion and 200-message page ceiling. An empty page retains its input `nextAfterId`, including zero, so a client can persist progress without inventing coverage from a timestamp overlap.
- R15: For every explicit `afterId` query, including zero and empty pages, respond with `data.historyCursor = { mode: 'after-id', afterId: requestedSafeInteger }` distinct from `nextAfterId`. Legacy `before` or latest requests must omit `historyCursor`; neither may imply complete coverage. Authentication and pair-scoped ascending query, bounded limits and malformed-input rejection are unchanged. Desktop rejects a missing or mismatched declaration before persistence.
- R16: Tombstone deletion, operation journal and reaction cleanup commit in one D1 batch transaction. A cleanup failure rolls back all three; a lost acknowledgement is recovered with the same operation ID after restart. Retrying an already journaled delete also repairs reactions left by the older separate-cleanup path without changing the message ID/revision or deleting resource bytes. Reaction writes atomically require a non-deleted message and participant identity, and reject a concurrent tombstone observed before the response rather than acknowledging a stale toggle. Storage errors remain visible and retryable.


### R17: Read-only production history verification

The existing Social Messaging owner gains a GitHub Actions-only, GET-only
verification consumer in `.github/scripts/human-messaging-production-readiness.mjs`.
Ordinary pushes and pull requests run its injected-fetch behavior tests only.
Production access requires an explicit `workflow_dispatch` with
`production_readiness=true`, canonical `main`, the `production` environment,
a protected authorization flag and approved source SHA, and separately supplied
protected credentials and a reviewed, pre-existing fixture. This is not permission
to merge, deploy, create accounts/messages/friendships, migrate, restore D1, or
modify production data. There is no default account, fixture, token or source SHA.
The protected approval must include a read-only call-chain review of the exact
deployed messaging source and its bound canonical identity service; HTTP GET
alone does not establish absence of state changes.

Before sending ordinary account credentials, the consumer reads the specified
successful canonical backend `production-worker-delivery.yml` main dispatch and
its exact run-attempt job from the fixed GitHub repository. The complete bounded
job log must bind the checked-out source SHA, deployed
`fabushi-flutter-web-prod` name and one emitted `Current Version ID`.
The consumer separately reads Cloudflare's current deployment and custom-domain
mapping. `api.ombhrum.com` must be enabled for this Worker's `production`
environment, and the first deployment must assign 100 percent of traffic to that exact version. The expected
SHA is an authorization constraint, not observed provenance on its own. The
consumer repeats the live deployment/domain reads after message checks and rejects
a changed deployment. This establishes a bounded control-plane/source association;
it is not per-request cryptographic attestation or a D1 data snapshot.

Only three credential-bearing origins are permitted:
`https://api.github.com` for the Actions read token,
`https://api.cloudflare.com` for a dedicated Workers Scripts Read token,
and `https://api.ombhrum.com` for ordinary account tokens.
All requests use GET and reject redirects. The sole exception is GitHub's
documented job-log 302: follow only the HTTPS Location returned by the fixed,
authenticated GitHub log endpoint, limited to documented Actions log hosts
(`*.blob.core.windows.net` or `results-receiver.actions.githubusercontent.com`),
with no Authorization header, no cookies and no second redirect. A URL supplied
by an operator or response body is never accepted as a network destination.
Bound response streams, total requests, per-request time, and the complete run;
never interpolate remote errors, bodies or URLs into logs.

The protected JSON fixture contains `actorUserId`, `peerUserId`,
`noncontactUserId`, `emptyPeerUserId`, `pageSize`, and the complete strictly
ascending `expectedMessageIds` for a stable existing conversation. All four
identities must be distinct positive safe integers. The expected set must span at
least two non-empty pages, with at most 31 non-empty pages and one terminal page
per traversal; `pageSize` is 1..200. The actor must already be friends with the
two peer fixtures, and the noncontact actor must already lack a friendship with
the target peer. No fixture is allocated or repaired by this consumer.

GET `/api/auth/user-info` must bind each existing ordinary account token to its
expected actor before any message result is accepted. Each explicit after-ID page
must echo exactly `historyCursor: {mode:'after-id', afterId:requestedCursor}`,
return the expected contact, remain within the declared participant pair, contain
strictly ascending unique safe message IDs matching the approved complete fixture,
and set `nextAfterId` to its last ID or the unchanged input cursor when empty.
The origin traversal, empty-origin pair and terminal empty page must all pass.
An anonymous origin GET must return 401; the existing authenticated noncontact
must return 403, with JSON error metadata and no message data. No other status is
accepted as an authorization-denial success.

Source review anchors for this verifier: backend
`06047d3ea69313ec4cfec58bbee36a7afc9cf007` routes `/api/social/messages` through
`community-routes.js` to `friends.js::handleListDirectMessages`. Its identity,
contact, accepted-friendship, page and reaction lookups are SELECTs; `read_at`
is projected as `readAt` without a read-receipt update. The earlier
`platform-gateway-routes.js` intercepts `/api/auth/user-info` and forwards to
the bound `MAHAYANA_PLATFORM` owner. Canonical Platform Core source
`26c3cc8c69ab89e8fb38952adb8c438ec0b68e05`,
`third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/worker_api.rs`
and `src/worker_api/account.rs`, routes this GET to `account_user_info`,
validates the token and current session, and SELECTs the existing account.
`serialize_account_user` emits top-level `id`, `role` and `isAdmin`; ordinary
fixtures require the expected ID, role `user` and `isAdmin=false`.
These source reads are not evidence of the identity Worker's current deployed
revision. Approval must confirm the live bound identity source remains read-only;
the verifier's messaging Worker provenance does not independently attest Core.

After the first page, retain a checkpoint only in memory, finish the traversal,
then re-read the exact suffix from that checkpoint and require the same identity
sequence and terminal cursor. Label this `client-readonly-checkpoint-reread`.
It does not prove a persisted Desktop restart, server restart, remote D1 restore,
rollback, or database recovery. Those remain separate acceptance requirements.

Environment contract:
- `FABUSHI_MESSAGE_PROBE_AUTHORIZED=true` and
  `FABUSHI_MESSAGE_PROBE_APPROVED_SOURCE_SHA` are protected production variables.
- Dispatch inputs supply only `provenance_run_id` and
  `expected_production_sha`; the latter must equal the protected approved SHA.
- `GITHUB_TOKEN` has repository Actions read permission.
- Dedicated production secrets are
  `FABUSHI_MESSAGE_PROBE_CF_READ_TOKEN`,
  `FABUSHI_MESSAGE_PROBE_CF_ACCOUNT_ID`,
  `FABUSHI_MESSAGE_PROBE_ACCOUNT_TOKEN`,
  `FABUSHI_MESSAGE_PROBE_NONCONTACT_TOKEN`, and
  `FABUSHI_MESSAGE_PROBE_FIXTURE_JSON`.
- No fallback to broader deployment credentials, account factories, local private
  files or unrelated production accounts is permitted.

Evidence contains source/run/version references, request status codes, counts and
redacted cursor ordinals. Actual account/message IDs, message bodies, token values,
Cloudflare account IDs, signed URLs and complete downloaded production logs stay
in memory and are not written to artifacts. Missing authorization, credentials,
fixture, source evidence, or current single-version routing returns non-zero
`blocked`; observed behavior mismatch returns non-zero `failed`. A successful
probe proves only the named read-only fixture checks, never full migration ACCEPT.

Official API contracts reviewed 2026-11-02:
- https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
- https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/

## 5. Current state

`fabushi/web/src/handlers/friends.js` owns friend-gated direct messages. Migration `20260713_friends_and_direct_messages.sql` defines `direct_messages`, including sender/recipient identity, body, created/read timestamps, and sender-scoped `client_request_id`. GET supports `before`; POST supports plain text only. Existing R2 handling can read objects but has no ordinary-user message upload ownership contract.

## 6. Target state

The same social messaging handler/service owns message relations and synchronization. R2 remains blob infrastructure; D1 stores resource ownership/provenance and message references. Clients materialize server messages locally but do not create a second remote truth.

## 7. Architecture and ownership boundaries

- Fabushi account auth: existing `requireStableAuth` / account token owner.
- Friend/peer authorization: existing friends social owner.
- Message truth: existing `direct_messages` D1 table.
- Reply relation: nullable reference from `direct_messages` to another direct message, validated against the same pair.
- Resource metadata/ownership: minimal `direct_message_resources` D1 table; bytes in existing R2 binding.
- Reaction truth: minimal `direct_message_reactions` D1 relation.
- Desktop Session/Transcript: downstream local materialization only; not backend truth.
- `x-fabushi-device-id`: device context only.

## 8. Interfaces / contracts / schemas / data flow

### POST /api/social/message-resources

Multipart/form-data field `file`.
Returns `{ success:true, resource:{ resourceId, name, contentType, size, createdAt } }`.
Maximum resource size: 25 MiB. Empty uploads fail.

### GET /api/social/message-resources/:resourceId

Requires authenticated owner or a sender/recipient of a direct message referencing the resource. Streams bytes with stored content type/name metadata and private cache headers.

### POST /api/social/messages

Existing fields remain. New optional fields:
- `replyToMessageId`: positive message id in the same peer pair.
- `attachments`: array of up to 10 objects containing `resourceId`; server rehydrates canonical metadata from `direct_message_resources`.

Text may be empty only when at least one canonical attachment is present. Existing 4000-character text and 200-character `clientRequestId` limits remain.

### GET /api/social/messages

Existing `contactId|username`, `limit`, `before` remain.
New:
- `afterId`: decimal non-negative safe integer (`0` through `9007199254740991`); returns messages with id greater than the cursor in ascending order. Explicit zero is the history origin. Omitted/blank values retain the legacy history query.
- `q`: trimmed search query, max 200 chars, case-insensitive substring search within the authorized peer pair.

`before` and `afterId` are mutually exclusive.

The response remains `{ success:true, data:{ contact, messages, nextAfterId } }` for legacy requests. An explicit `afterId` request additionally returns `historyCursor: { mode: 'after-id', afterId: <requested number> }`; this is the requested cursor, not the returned high-water `nextAfterId`. Empty origin and terminal pages still echo the exact request. Omitted and `before` requests do not receive a cursor declaration.
For an explicit cursor, `nextAfterId` is the last returned message ID, or
the input cursor when no messages are returned. It is therefore zero for
an empty origin page. No `hasMore` or timestamp-contiguity claim is added.
ID traversal covers equal timestamps and messages whose creation times do
not follow ID order. Existing requests without a cursor keep their
`created_at`/ID ordering and strict `before` behavior; clients needing full
coverage must use the explicit ID cursor. The cursor is not a changefeed
for reactions or edits to older message IDs.

Each message includes:
`id,senderUserId,senderUsername,recipientUserId,recipientUsername,text,clientRequestId,createdAt,readAt,isOutgoing,replyToMessageId,attachments,reactions,revision,editedAt,deletedAt,isDeleted`.

### PATCH /api/social/messages/:messageId

Body `{ text, operationId, expectedRevision }`. Only the original sender may edit. The message ID is stable; a successful mutation increments `revision`, sets `editedAt`, and returns the authoritative canonical message. Empty text is accepted only when the existing message still has canonical attachments. Deleted messages cannot be edited.

### DELETE /api/social/messages/:messageId

Body `{ operationId, expectedRevision }`. Only the original sender may delete. Deletion is a durable tombstone rather than row removal: the message ID remains addressable for reply/provenance, `revision` increments, `deletedAt` is set, body/attachments are cleared, and message reactions are removed. A new delete operation against an already deleted message is rejected; retrying the same `operationId` is idempotent.

Both mutation endpoints return HTTP 409 for stale `expectedRevision` and include the current canonical message when available. `operationId` is bounded to 200 characters and is persisted in `direct_message_mutations` with a SHA-256 request digest so an ID cannot be reused for another payload.

### POST /api/social/messages/:messageId/reactions

Body `{ emoji, active }`. `active=true` upserts the authenticated user's reaction; `active=false` removes it. Emoji is non-empty and bounded to 32 Unicode scalar bytes. Returns the canonical reaction summary for the message.

## 9. Constraints and non-functional requirements

- All endpoints require first-party account authorization.
- R2 object keys are private implementation details and never returned.
- Resource IDs are unguessable UUIDs and object reads are authorization checked.
- Upload redirects are not involved.
- Query limits are bounded; no unbounded message/reaction scan is exposed.
- Existing plain-text API behavior remains backwards compatible.
- No Telegram runtime/network dependency.

## 10. Failure modes and edge cases

- Duplicate `clientRequestId` returns the previously persisted canonical message.
- Duplicate retry with different local payload is resolved to existing server content; clients must reconcile to server truth.
- Reply to a foreign conversation returns 400/403 and persists nothing.
- Resource owned by another account returns 403 and persists nothing.
- Missing R2 binding returns 503/500 without writing a dangling message resource.
- Network retry after ambiguous POST is safe because `clientRequestId` remains idempotent.
- Incremental sync may repeat already materialized messages; stable server message IDs make reconciliation idempotent.
- Mutation retry after an ambiguous response is safe because the same `operationId` resolves to the already-applied authoritative mutation.
- A stale edit/delete cannot overwrite a newer revision; the service returns 409 with current canonical state for reconciliation.
- A tombstoned message stays in history/reconnect results with stable ID and deletion metadata, while body/attachments/reactions are removed.
- Deleted/missing resource fetch returns 404; message metadata remains durable for provenance.

## 11. Implementation strategy

1. Add D1 migration for reply id, attachment JSON/resource table, and reaction relation.
2. Extend social handler helpers for pair validation, resource validation, reaction projection and message mapping.
3. Add upload/download resource handlers and routes.
4. Extend message POST/GET with reply/resources/afterId/search.
5. Add reaction mutation route.
6. Add focused Node contracts and integration-style D1/R2 mocks.
7. Add monotonic message revision fields plus a durable mutation-operation table; implement sender-only edit/tombstone-delete routes with optimistic revision fencing and operation-idempotency.
8. Extend focused contracts and D1 mocks for edit/delete replay, stale-revision rejection, recipient denial, and tombstone projection.
9. Wire Desktop Host adapter only after these server contracts exist.

## 12. Verification / test strategy

GitHub Actions only. Verify migration shape, old plain-text behavior, idempotent POST, cross-pair rejection, resource ownership, R2 authorization, attachment-only messages, reply projection, reaction toggle/projection, before/after pagination, q search, and two-device convergence by server message ID/clientRequestId. For message mutations additionally verify stable ID, monotonic revision, same-operation replay, operation-ID mismatch rejection, stale-revision 409, sender-only authorization, edit-after-delete rejection, and tombstone content/reaction cleanup. The 2026-11-02 FMEP-001 Revision 2 authorization permits focused batch validation on the existing checkpoint in GitHub Actions; no local validation is permitted. Authored tests remain `not-run` until exact-commit execution evidence exists.

R14 uses the existing handler/D1-mock behavior harness to traverse 450
same-timestamp messages in pages of 200/200/50/0, prove participant-pair
isolation, zero and terminal empty cursors, page limits, malformed cursor
rejection before message reads, and compatibility of legacy history
ordering. These controlled handler contracts do not establish deployed
service acceptance or independently validate the SQLite engine.

R16 adds a separate Node 22 built-in SQLite suite that loads the real three
message migrations and invokes the production handlers through a D1-shaped
SQLite adapter. It checks preservation of existing rows and foreign keys,
cleanup-trigger rollback, post-commit acknowledgement loss, repair of an older
partial tombstone, delayed reaction add/remove versus deletion, reaction replay
and authorization, edit replay/revision conflicts, competing edits, and real
450-row origin pagination with file-database reopen. The original 29 checks
include five source-marker mutation contracts; they are not mutation behavior
proof. The additional ten SQLite tests have their own count/log gate. A local
SQLite transaction is not an observation of deployed Cloudflare D1; production
authenticated pagination, active Worker provenance and isolated remote recovery
remain separate requirements. No local tests are authorized by this addition.

## 13. Acceptance criteria / Definition of Done

- AC-1: Existing plain-text friend direct messaging remains passing and backward compatible.
- AC-2: Reply and attachment-only/text+attachment sends persist and round-trip with server-canonical metadata.
- AC-3: Foreign reply/resource/reaction access fails closed.
- AC-4: Reaction changes round-trip and are visible to the peer.
- AC-5: `afterId` supports idempotent reconnect convergence and `q` returns only authorized peer-pair matches.
- AC-6: Two devices authenticated to one account converge on the same remote message IDs without device identity becoming account identity.
- AC-7: Message resource bytes are private and readable only by authorized participants.
- AC-8: All backend exact-HEAD required CI is green before merge.
- AC-9: Edit changes the existing canonical message in place, increments `revision`, and converges to the same server message ID on all clients.
- AC-10: Delete produces a durable tombstone with the same message ID, clears user content/attachments/reactions, and keeps reply/reconnect ordering deterministic.
- AC-11: Mutation idempotency and optimistic concurrency are fail-closed: exact operation replay is safe, operation-ID reuse is rejected, and stale revisions cannot overwrite newer state.
- AC-12: Origin-ID pagination executes the R14 behavior matrix at the exact backend commit with no failed/skipped cases; preserve all existing messaging and call contracts. Bind workflow checkout, complete logs and actual test totals to that SHA. Desktop persistence/32-page continuation/restart and eventual production deployment require their own evidence and are not implied by this backend increment.
- AC-13: Explicit cursor echo and unchanged legacy shape pass a real handler/D1 mock contract with origin, sparse, empty, max-safe and unauthorized scenarios. Exact-commit CI must execute 29/29; mocked handler acceptance never establishes active production deployment.
- AC-14: The exact backend commit passes the existing 29 checks and all ten separately counted SQLite behavior/recovery tests with zero failed/skipped/cancelled cases. A delete cleanup failure leaves the original message/revision/reactions and no journal; restart/retry or lost-ack replay yields one journal and a stable tombstone without reactions. Delayed reaction add/remove against that tombstone fails closed. Existing message/resource identity and foreign keys survive additive migration and reopen. These results do not authorize deployment or establish remote D1 restore acceptance.

- AC-15: The read-only production verifier passes its separately counted injected-fetch contracts at the exact backend commit. Tests cover real provenance request construction and token-origin isolation, log redirect handling, active-version/domain drift, identity and pair isolation, bounded pagination and empty cursors, denial failures, redaction and checkpoint reread. Mock provenance/handler responses are not production acceptance. Actual execution requires the R17 protected configuration and a successful live report; remote D1 recovery and independent ACCEPT remain unverified.

## 14. Release / migration / rollback

Migration is additive. New nullable/defaulted mutation fields preserve existing rows and initialize them at revision 1. The mutation-operation table may remain unused by old clients. Tombstone deletion clears message attachment references but deliberately does not synchronously delete R2 bytes; resource garbage collection remains a separate lifecycle responsibility. Rollback of application code leaves additive schema intact.

R14 changes no database schema or stored data. Rollback of cursor admission
makes origin requests fail with 400; dependent clients must retain their
durable progress and surface that failure, not silently substitute a
timestamp query and claim complete coverage. This checkpoint is not a
production deployment authorization or proof.

### Release order (required)

1. Apply `fabushi/web/migrations/20261031_human_message_mutations.sql` to production D1 **once**, before deploying the Worker. The new Worker selects `revision`, `edited_at` and `deleted_at` on every history read; deploying it first would make list/send/reaction requests fail with 500. The migration uses bare `ALTER TABLE ADD COLUMN` and is **not re-runnable** (a second run fails with duplicate column, before any change).
2. Deploy the Worker through the main-only production delivery workflow with explicit approval.
3. Run authenticated real-service checks: afterId=0 multi-page and empty-cursor traversal, authorization denial negatives, edit/delete revision conflicts, provenance SHA.
4. Rollback: redeploy the previous Worker and leave the additive schema in place. Old clients then see tombstoned messages as empty messages and the old reaction handler may accept reactions on them again; edited/deleted content is intentionally unrecoverable.

Edit/delete requests with malformed or non-object JSON return 400. DELETE may omit its body and pass `operationId` and `expectedRevision` as query parameters; body values take precedence.

## 15. Observability / evidence

CI logs and exact commit SHA are required evidence. API failures return bounded user-safe errors; secrets/object keys are not logged or returned. Device header may be included in future structured telemetry but is not persisted as ownership.

## 16. References / provenance

- Fabushi Desktop FBCP-001 and PR #27.
- Existing backend `fabushi/web/src/handlers/friends.js`.
- Existing migration `fabushi/web/migrations/20260713_friends_and_direct_messages.sql`.
- Existing R2 read owner `fabushi/web/src/handlers/assets.js`.
- Telegram Desktop frozen source is a product-behavior research source only; no Telegram code/protocol is introduced here.
- D1 batch transaction/rollback contract: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch (read 2026-11-02).

## 17. Spec compliance record

| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| R1-R10 | passed | Implemented in the canonical social messaging owner; executable source + handler-level D1/R2 contracts passed on implementation HEAD `1c544e5405512a4bd55b25cc9759fc5f55ad3612`, Human Messaging CI run `37249986917`. |
| AC-1-AC-8 | passed (historical baseline) | Backward compatibility, reply/resources/reactions, fail-closed authorization, `afterId` reconnect, `q` search, two-device convergence, private R2 reads, and exact-HEAD CI were covered by run `37249986917` on the prior implementation baseline. This is not validation evidence for the Stage-A mutation work. |
| R11-R13 / AC-9-AC-11 | implemented; scoped handler/SQLite evidence passed | Exact `06047d3ea69313ec4cfec58bbee36a7afc9cf007`, runs `41427242843` and `41427235133`: existing29 plus real SQLite10, zero failed/skipped/cancelled. Includes atomic delete/reaction cleanup, rollback, lost-ack replay, concurrent mutation and reopen. Deployed D1 and complete production acceptance remain blocked. |
| R14 / AC-12 | passed on checkpoint only | `cc3b7ef10a6646c6ee1a99bd068238c7f9530421`, run 41407127408: 28 tests passed, zero failed/skipped; does not imply deployed acceptance. |
| R15 / AC-13 | passed on exact checkpoint only | Exact `06047d3ea69313ec4cfec58bbee36a7afc9cf007`, runs `41427242843` and `41427235133`: existing29/29 including cursor echo. Additional SQLite10 includes real-engine afterId=0 multipage/empty/pair isolation. No active Worker or authenticated production qualification is implied. |
| R16 / AC-14 | passed on exact checkpoint only | Same exact `06047d3ea69313ec4cfec58bbee36a7afc9cf007` push/PR runs passed real SQLite10/10 and original29/29. Full logs were read in round12; artifacts `13131943502` (`sha256:80f1e5a3ee86ec2c069c195238700fdfaac5b68e16bfa66f28e80bfe8945080f`) and `13132637021` (`sha256:494a06c311d6a7105d36b1870eb00ad66e00e998f42cbbcada7ee8682fb44809`). No production mutation or remote D1 restore performed. |
| R17 / AC-15 | verifier contract passed; real production blocked | Exact `013c5460049f2f75843ebc0c8c736e287d32789c`, push `41509986961` and PR `41509996583`: original29/29 + SQLite10/10 + readiness24/24, all fail/cancelled/skipped/todo0. Both production jobs were skipped, not passed. Full logs, actual ZIP contents/digests, source binding and independent static review are in `docs/evidence/human-messaging-readiness-round12-20261102.json`. Real authorized production fixture/source execution remains unaccepted. |

### Round12 current delivery and production boundary

On 2026-11-02 the backend checkpoint and Draft PR137 were reread at
`06047d3ea69313ec4cfec58bbee36a7afc9cf007`; main remained
`687718ce9e0083aa124d29005bcce4051d357919`. Reviews and conversation comments
were both zero, the PR was unmerged, and no formal production authorization was
observed. The latest traceable canonical delivery read was run `40047409890`,
source `33a26692ce2f74e3fdca3940dfc4cbfb3ede151b`, Worker version
`3ad1a889-4c28-4344-8472-8c8adc225a3c`. Its full logs and provenance/recovery
artifacts were inspected. This historical delivery is not a current active
control-plane observation, and its recovery artifact contains only a D1 bookmark,
not a successful restore. That source rejects origin `afterId=0` and has no
historyCursor contract. The verifier passed its exact-head controlled Actions at `013c5460049f2f75843ebc0c8c736e287d32789c`
(push `41509986961`, PR `41509996583`), each63/63 with production explicitly
skipped; no production probe, merge, deployment, fixture creation or data
modification occurred in this increment. Missing compatible authorized
deployment, protected read credentials and approved existing fixture remain
explicit production blockers.
