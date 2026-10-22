# Global Dandelion 0.4.4: reviewed native link download delivery

The user requested pasted URLs to download their linked resources for sending.
The implementation belongs to bhrumom/global-dandelion-rs and the installed Rust
Mini App. This backend change adds exactly 0.4.4 to the reviewed native-version
allowlist; it introduces no download or Mini App business code into the Host.

Requirements: preserve canonical-main manual production signing, exact source SHA,
preparation artifact ID/archive digest, every resource hash, native Mach-O/contract
validation, pinned managed signing root and explicit native.runtime review flag.
The renderer's deny-network policy stays unchanged; outbound resource requests
run in the version-authorized native package. Downloads must be public HTTP(S),
streamed/bounded, DNS-pinned, private-destination/redirect blocked and cancellable.
No page scripts, shared browser credentials, implicit file sends or arbitrary
public CI fixtures. Existing global-node provisioning and macOS AP work are not
part of this release and must not be reported complete.

Before dispatch: exact committed source CI, dependency policy, Apple native core,
real native-worker/loopback contracts, browser paste tests and preparation package
must all pass. Add explicit 0.4.4 positive fixture and retain 0.4.5/unreviewed-version
rejection. Backend tests run in Actions only. No reviewer secret in PR runs.

Delivery: reviewed source/package -> backend exact-head CI -> merge -> one manual
protected production workflow -> verify immutable signed bytes/catalog binding ->
local installed package update. New-version native execution consent and live
link-download/receipt acceptance remain separate user/device gates. Rollback uses
existing immutable version/Registry controls; do not overwrite 0.4.3.

Acceptance LD-REL01 source/CI: pending; LD-REL02 backend policy CI: pending;
LD-REL03 protected signing/catalog: pending; LD-REL04 local installed/runtime: pending.
