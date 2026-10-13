# Global Dandelion reviewed package delivery

Status: active implementation slice. Date: 2026-10-13.
Parent: fabapp-manifest-signing-v1.md / OMA-001.

The administrator requested completing publication as a proprietary mini app.
Use the existing production signer, not a new signing authority. This slice
produces an integrity-signed package, NOT a Registry approval or public listing.

## Requirements and acceptance

- GD-01: manual canonical-main production-environment workflow only. No PR
  workflow receives reviewer credentials. Pin the preparation repository, exact
  source SHA, successful Actions artifact ID and archive digest in reviewed code.
- GD-02: validate ZIP members without extraction: bounded sizes/count, no duplicate,
  absolute, traversal, symlink, encrypted or undeclared members. Verify every
  declared resource size/hash and BUILD-INFO source before requesting a signature.
- GD-03: bind app/publisher/version, deny network and empty capability request;
  preserve the explicit offline-workbench/native-feature limitations.
- GD-04: reviewer token exists only in the production runner environment and
  HTTPS request header to the fixed production signing endpoint. Reject redirects.
  Never print credential, response diagnostics or private key material.
- GD-05: verify returned manifest equality and Ed25519 signature against the
  independently pinned managed raw public key/key ID/epoch; reject changed trust.
- GD-06: deterministic immutable .fabapp and public provenance include preparation
  source, artifact digest, backend delivery source, signer identity and package
  digest. Upload signed bytes only after all checks. No automatic release approval.

Tests run exclusively in GitHub Actions: corrupt/extra/duplicate/traversal/symlink
resources, source mismatch, changed signer/manifest and valid fixture signature.
Live acceptance requires the protected main workflow to sign via the real Worker.
Registry scan, namespace ownership, release review/signature and installed desktop
Host acceptance remain separate requirements; this slice cannot report them done.
