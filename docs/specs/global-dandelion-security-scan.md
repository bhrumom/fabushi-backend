# Global Dandelion pinned artifact security scan

Status: implementation slice, 2026-10-13. Existing Marketplace reviewer owner.
User requests completing proprietary publication; signed package is not approval.

- GS-01: only canonical-main production-environment Actions may record verdicts.
  Pin successful signing run/artifact/archive/package/source digests in code.
  Download and validate exact artifact before requesting immutable scan verdict.
- GS-02: verify duplicate-free ZIP/JSON, resource hashes/sizes, app/publisher/version,
  denied network, zero capabilities, source identity, Ed25519 domain signature and
  independent managed-key pin. Require packaged CSP deny-network/worker/frame,
  actual Wasm entry and no native executable. This narrowly reviewed candidate is
  an offline packet workbench, not full native LAN/WAN functionality or a general
  malware certification. Preserve proprietary/native-unavailable descriptors.
- GS-03: record actual checks and immutable provenance via existing scan route.
  Optional expectedDigest/expectedSizeBytes atomically fences the bound artifact
  before any verdict/audit mutation; mismatches fail with ARTIFACT_BINDING_CONFLICT.
  Legacy scanner callers remain compatible, but this production scanner always
  supplies both fields. Do not mark a different server artifact passed.
- GS-04: no publisher impersonation, forged human approval, or automatic release
  approval. Scanning and final review/publication remain separate. Secret only in
  fixed HTTPS header; reject redirects, bound response, redact diagnostics. No
  uncertain-write retries. Re-running final verdict requires explicit reconciliation.

Actions tests: digest/size mismatch cannot finalize; valid pinned signature/resources;
tamper/missing resources/source/policy/signature rejection. Exact candidate's source
offline Wasm/browser CI is additional provenance, not substituted by this scanner.
Acceptance: genuine publisher submits package, protected scan succeeds for the same
server binding, then separate release review/signature/catalog and installed Host
acceptance. Pending until observed. Rollback keeps existing approved versions;
scan is immutable and no local/remote manual database edits are permitted.
