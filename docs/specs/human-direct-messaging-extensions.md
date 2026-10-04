# Fabushi Human Direct Messaging Extensions — Specification

Status: active
Owner: Fabushi Backend / Social Messaging
Last updated: 2026-10-05
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
- `afterId`: positive integer; returns messages with id greater than the cursor in ascending order.
- `q`: trimmed search query, max 200 chars, case-insensitive substring search within the authorized peer pair.

`before` and `afterId` are mutually exclusive.

Each message includes:
`id,senderUserId,senderUsername,recipientUserId,recipientUsername,text,clientRequestId,createdAt,readAt,isOutgoing,replyToMessageId,attachments,reactions`.

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
- Deleted/missing resource fetch returns 404; message metadata remains durable for provenance.

## 11. Implementation strategy

1. Add D1 migration for reply id, attachment JSON/resource table, and reaction relation.
2. Extend social handler helpers for pair validation, resource validation, reaction projection and message mapping.
3. Add upload/download resource handlers and routes.
4. Extend message POST/GET with reply/resources/afterId/search.
5. Add reaction mutation route.
6. Add focused Node contracts and integration-style D1/R2 mocks.
7. Wire Desktop Host adapter only after these server contracts exist.

## 12. Verification / test strategy

GitHub Actions only. Verify migration shape, old plain-text behavior, idempotent POST, cross-pair rejection, resource ownership, R2 authorization, attachment-only messages, reply projection, reaction toggle/projection, before/after pagination, q search, and two-device convergence by server message ID/clientRequestId.

## 13. Acceptance criteria / Definition of Done

- AC-1: Existing plain-text friend direct messaging remains passing and backward compatible.
- AC-2: Reply and attachment-only/text+attachment sends persist and round-trip with server-canonical metadata.
- AC-3: Foreign reply/resource/reaction access fails closed.
- AC-4: Reaction changes round-trip and are visible to the peer.
- AC-5: `afterId` supports idempotent reconnect convergence and `q` returns only authorized peer-pair matches.
- AC-6: Two devices authenticated to one account converge on the same remote message IDs without device identity becoming account identity.
- AC-7: Message resource bytes are private and readable only by authorized participants.
- AC-8: All backend exact-HEAD required CI is green before merge.

## 14. Release / migration / rollback

Migration is additive. New nullable/defaulted fields preserve existing rows. New tables may remain unused by old clients. Rollback of application code leaves additive schema intact. R2 bytes are not deleted by rollback; cleanup policy is a later lifecycle responsibility.

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
| R1-R10 | blocked | implementation and exact-HEAD verification pending |
| AC-1-AC-8 | blocked | implementation and exact-HEAD verification pending |
