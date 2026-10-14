# Protected review of the exact offline preview

Owner: existing ExtensionReleaseStore review API. Date: 2026-10-14.

The real publisher submitted Global Dandelion0.1.0 through the signed Desktop
f3466860220f142813786b511b1ede55576fa7ac; native UI reports pending_review.
Review is a separate manually dispatched, canonical-main production job, not a
scan side effect. It can approve only web-miniapp/bhrumom/global-dandelion/0.1.0.

Before its single approval write, validate the exact Desktop source's completed
CI and real signed packaged acceptance, and immutable protected scan38453729078
from backend99438998520a782910c42cdbc04a2ccf16e46e17. Bind the scan artifact to its
whole GitHub artifact digest, .fabapp digest de10e02115415908f827723457817e51cb4f39aa5ca68798da824fecc483118a,
size453093, Wasm sourcefce746baecc6bbd9f4b12d5862d886cf7f72eda5,
managed key and explicit offline-workbench scope. No caller-selectable identity,
version, URL, credentials, scan run or approval bypass. No uncertain write retry.

Existing server pending-state immutability, artifact approval gate and managed
release signing remain authoritative. Reviewer is an honestly labeled protected
release operator, not an invented human peer/hardware acceptance. LAN/WAN/hotspot/
system scan are unavailable. After approval, verify public install proof and exact
artifact binding; actual installed-client acceptance remains a distinct required
step, and publication is not claimed merely from an approval response.

Secrets remain production environment inputs. Never print private release fields,
tokens, paths or upstream error bodies. Actions unit tests cover source/CI failure,
scan digest/scope/source swaps and oversized/unexpected artifacts. Rollback is the
existing release revoke/yank workflow, not a database edit or key rotation.

## Traceable acceptance and execution

- RR-01: exact-source successful run names/SHAs and immutable scan artifact
  metadata/whole ZIP digest are required before any mutation.
- RR-02: one fixed HTTPS review write through the existing reviewer owner; no
  redirects, arbitrary caller identity, automatic retry or secret diagnostics.
- RR-03: public approved proof must expose the same fixed package/version after
  approval. Record public evidence only; approval is not installed acceptance.
- RR-04: unit verification executes only in GitHub Actions (never a workstation).
  Separate manual production workflow is never triggered by a PR or test.

Plan: pure gate validators and negative unit fixtures -> exact-head Actions CI ->
review PR/integrate -> manually dispatch protected main once -> inspect public
proof -> separate Desktop installed/offline/remove gates. Existing service API,
database, key, namespace and scan records are unchanged; no migration/deployment.
Failure before write is blocked; uncertain write requires read-only public-proof
diagnosis rather than rerunning. Evidence records RR-01..04 and remaining gates.
References: backend scan38453729078, Desktop PR64/source f346686, real publisher
pending-review observation and user request to finish publication (2026-10-14).
