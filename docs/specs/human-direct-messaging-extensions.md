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

## 14. Release / migration / rollback

Migration is additive. New nullable/defaulted mutation fields preserve existing rows and initialize them at revision 1. The mutation-operation table may remain unused by old clients. Tombstone deletion clears message attachment references but deliberately does not synchronously delete R2 bytes; resource garbage collection remains a separate lifecycle responsibility. Rollback of application code leaves additive schema intact.

R14 changes no database schema or stored data. Rollback of cursor admission
makes origin requests fail with 400; dependent clients must retain their
durable progress and surface that failure, not silently substitute a
timestamp query and claim complete coverage. This checkpoint is not a
production deployment authorization or proof.

## 15. Observability / evidence

CI logs and exact commit SHA are required evidence. API failures return bounded user-safe errors; secrets/object keys are not logged or returned. Device header may be included in future structured telemetry but is not persisted as ownership.

## 16. References / provenance

- Fabushi Desktop FBCP-001 and PR #27.
- Existing backend `fabushi/web/src/handlers/friends.js`.
- Existing migration `fabushi/web/migrations/20260713_friends_and_direct_messages.sql`.
- Existing R2 read owner `fabushi/web/src/handlers/assets.js`.
- Telegram Desktop frozen source is a product-behavior research source only; no Telegram code/protocol is introduced here.

## 17. Spec compliance record

| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| R1-R10 | passed | Implemented in the canonical social messaging owner; executable source + handler-level D1/R2 contracts passed on implementation HEAD `1c544e5405512a4bd55b25cc9759fc5f55ad3612`, Human Messaging CI run `37249986917`. |
| AC-1-AC-8 | passed (historical baseline) | Backward compatibility, reply/resources/reactions, fail-closed authorization, `afterId` reconnect, `q` search, two-device convergence, private R2 reads, and exact-HEAD CI were covered by run `37249986917` on the prior implementation baseline. This is not validation evidence for the Stage-A mutation work. |
| R11-R13 / AC-9-AC-11 | specified; validation not-run | Stage-A contract for edit/delete. Runtime/schema/tests must be implemented on the isolated checkpoint and remain unverified until the frozen GitHub Actions validation campaign. |
| R14 / AC-12 | passed on checkpoint only | `cc3b7ef10a6646c6ee1a99bd068238c7f9530421`, run 41407127408: 28 tests passed, zero failed/skipped; does not imply deployed acceptance. |
| R15 / AC-13 | implemented; exact-H validation pending | Round 8 explicit historyCursor response and handler behavior test; target 29/29 via GitHub Actions. Active Worker and desktop continuation remain blocked until separate evidence. |

