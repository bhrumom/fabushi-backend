# FDN production environment completion evidence

The two external prerequisites are now configured. Full MCP/Host transport
acceptance remains separately blocked and must not be inferred from this record.

| Layer | Exact source | Evidence | Result |
| --- | --- | --- | --- |
| Core authority/session owner | c7d0e24b7561c6f5d1bb3c0e975f599643252504 | delivery38695093688, exact-main OAuth38694611563 and session38694611402 | passed |
| Controller services |4213b49d88a8441968477ca1de59e7033f1b4bdd|[deployment38830333777](https://github.com/bhrumom/fabushi-backend/actions/runs/38830333777)| build+real install+health passed |
| Independent service HTTP/provenance | runtime4213b49; inventory sourceb06a45d795c7e56fd1a88f8ae63d25d970ae1088 |[38830843065](https://github.com/bhrumom/fabushi-backend/actions/runs/38830843065)| four active services/timer, workerready, MCPhealthy, enrollment401, ingressbinder success |
| Account API |3c195ff138715cc5040bb8b36ddd1e4153363070|[38831456633](https://github.com/bhrumom/fabushi-backend/actions/runs/38831456633)| ARM64 full142 before+142 after prune, immutable install, public health passed |
| Public enrollment gateway |3c195ff138715cc5040bb8b36ddd1e4153363070|[38831459832](https://github.com/bhrumom/fabushi-backend/actions/runs/38831459832)| canonical production deployment, start/complete401 with existing-account-api marker |
| G11 browser/Box | Desktopc33a9495fc1e640557d65f3e2daedc1449be7fcb |[38731191530](https://github.com/bhrumom/fabushi-desktop/actions/runs/38731191530), fullowner38731189125| real direct12+shipping Rust/Box12, fail0,skip0 |

Seven encrypted production FDN inputs exist. Credentials are never committed or
copied into artifacts. Dedicated ordinary production identity was created through
canonical registration/login/profile validation; isolated factory accounts were
not promoted. One cell/controller identity was enrolled with a bounded nonreusable
key; persistent tsnet identity and independent durable broker/state/vault keys remain
private. Operator OTP and pending challenge files were consumed/deleted.

First actual activation exposed the rootless-socket sandbox and AF_NETLINK needs;
BackendPR101 corrected hardening/readiness/rollback. Actual118c4a2 registered the
controller and bound Core ingress but exposed Node's current-symlink entry guard.
PR102 corrected it and tested a real child listener. PR103 recorded independent
liveness. PR104 connected the two missing canonical Host enrollment gateway paths.

BackendPR101 exact003fe6e run38828838237 passed four activation/reinstall/rollback
contracts plus existing suites. PR102 exactf831fb9 run38830016942 passed six service
contracts including actual symlink listener401 and invalid configuration exit1.
PR104 exactba6d23c run38831399822 passed7 account-proxy+4 gateway contracts;
static delivery38831399637 passed. All executable tests/builds were Actions-only.

Controller bundle SHA256:
086e9a2f065825e10c40ee6bd5144be44805a87d68c8b2f602ad3ebb3a363da9.
Read-only administrative process inventory confirmed account API active release3c195ff
and all three dedicated proxy settings, without displaying their credential values.
Existing data, original env, registry/signing ownership and legacy public MCP remain.

## Remaining acceptance

AC-3 / G05/G16 remain blocked: actual production OAuth-to-target Host, native
permission/execution, direct WireGuard, DERP, authenticated reverse-WSS, live
cross-account/revoke denial and response-loss/outcome_unknown/no-replay evidence.
Neither protected secrets, enrolled controller, public health/401 nor real G11
browser fixtures proves that chain. No public MCP cutover or complete E2E claimed.
