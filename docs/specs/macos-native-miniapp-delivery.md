# Reviewed macOS native Mini App delivery

Status: active, 2026-10-20. Latest user direction: Mini App functions must be
installed with the Mini App rather than built into Fabushi; finish macOS first.
This extends GD-03 only for an explicitly selected macOS native release. Legacy
offline deliveries keep their empty-capability gate unchanged.

MND-01: protected canonical-main workflow accepts an explicit native-runtime
mode, reviewed versions 0.4.0 and 0.4.1 only. Version 0.4.1 is the
user-requested globe composer update; 0.4.0 remains immutable/reproducible. Validate signed-resource descriptor
`fabushi.native-runtime.v1`, darwin/arm64, native worker/executable paths, bounded
arm64 Mach-O bytes and exact file hashes/source. Reject hidden binaries or
native capabilities outside that mode; never disguise executable bytes as text.

MND-02: use the existing strict fabapp v1 managed signer and trust root; retain
network-denied Web content and minHostApi=2. Requested `native.runtime` must
match the reviewed source descriptor and package. Signatures do not grant Host
execution; the generic Host separately requires native-code confirmation.

MND-03: native artifact is Desktop/arm64, not universal/all-platform. Publish
native-code scope accurately and bind package/version/source/digest/reviewer.
Integrity signing, release approval and installed execution remain independent.

MND-04: no PR secrets, no local executable tests, no remote deployment required:
the existing signer accepts valid capability IDs and MIME declarations. Only
the protected delivery adapter gains this explicit reviewed mode. Mutation tests
must prove legacy/native boundary, target mismatch, undeclared executable and
descriptor mismatch rejection before the protected pipeline is dispatched.

Failures retain old immutable versions and fail closed. All MND-01..04 pending
exact-head Actions and protected signing/review evidence. Full macOS features
need installed proof in Desktop and actual native implementation in the Mini
App repository. Parent: global-dandelion-package-delivery.md and
fabapp-manifest-signing-v1.md.

The reviewed runtime may also declare `package-update`: the generic Host broker
can check/install only this same app through its existing approved catalog and
uninstall/update lifecycle. It does not authorize self-patching native bytes.

2026-10-21 update: same darwin/arm64 descriptor and Host grants for 0.4.1.
Retain exact preparation source/artifact/digest validation and production-only
signer. Reject unreviewed future versions; no wildcard version policy. Actual
installed Mac UI/version proof remains separate from successful signing.
