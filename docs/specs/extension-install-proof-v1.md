# Approved Web Mini App install proof v1

Status: implementation, 2026-10-13. Existing Marketplace Registry/SQLite/signing owner.
Parent: extension-release-signing-v1, extension-trust-feed-v1, OMA/FPM.

The browse projection drops immutable release signature/artifact fields and cannot
authorize native installation. Add a narrow public proof endpoint, not a new store
or approval route. Existing Worker manifest signer `/v1/extensions/trust` response
is unchanged; the proof embeds the existing Node signed trust feed separately.

- IP-01: GET /v1/extensions/install/:kind/:namespace/:name/:version only returns
  approved, non-revoked web-miniapp releases whose current managed signature is
  trusted and every bound artifact has passed scan. Otherwise generic404, no draft,
  reviewer notes, account identity or package paths. Response cache-control no-store.
- IP-02: `{protocol:'fabushi.extension-install-proof.v1',descriptor,
  descriptorPayload,releaseSignature,trust}` uses existing immutable signature and
  current signed trust-feed envelope. descriptorPayload is exact JSON.stringify of
  stored normalized descriptor; SHA256 binds it to both stored descriptorDigest and
  signed payload. Clients hash exact UTF8 bytes, never reserialize Node insertion
  order as Rust sorted-map JSON. Parsed descriptor must equal its outer projection.
- IP-03: signed identity/version and full artifact list must match actual binding,
  including digest/size/platform/architecture/format. Descriptor bundleDigest must
  match a signed fabapp artifact. Changing metadata/binding cannot produce a proof.
- IP-04: no new key, no self-sign trust or verification badge. Native Host separately
  verifies pinned feed/release signatures, freshness/revocation/platform/account,
  then downloads fixed approved CAS and verifies manifest/resources. Proof is not
  execution permission. Offline last-good policy remains platform-owned.
- IP-05: GET /v1/extensions/install-trust returns `{trust}` using the existing
  signed Node trust feed with no-store. This distinct name avoids the Worker's
  manifest-pin route without changing that route. Native clients refresh and
  verify this feed independently of approved proof availability, so a revoked
  key cannot disappear behind a proof404 while cached code remains executable.
  Only transport failure permits a previously accepted offline snapshot; malformed
  or rejected online evidence fails closed. The response carries only existing
  public key/status metadata, not reviewer credentials or release drafts.

Verification exclusively Actions: actual Ed25519 fixture, public privacy, draft,
revocation/missing signature, descriptor/artifact tamper and scan failure. Existing
Registry/signature/Artifact/MCP contracts and ARM production deployment must pass.
Acceptance: live approved proof matches genuine publisher release and installed
Host; pending until observed. Rollback removes only public read endpoint, retains
all immutable release data, keys, approvals, artifacts and previous client behavior.
