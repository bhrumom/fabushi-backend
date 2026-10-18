# FDN G15 official device MCP production resource/privacy evidence

This slice measures the real shipping `fabushi-fdn-official-device-mcp.service`, not an injected `accountClient` or a mock MCP server.

The production probe is valid only when the controller's deployed `BACKEND_SHA` equals the workflow exact main SHA and its `CORE_SHA` equals the verified current Platform Core main SHA. It samples five minutes of the live Node process and enforces RSS < 150 MiB, single-core average CPU < 1%, state/audit/journal <= 20 MiB, and filesystem free space >= max(1 GiB, 5%). It scans only journal output for credential-like material; it never copies the MCP state file because that file intentionally contains local OAuth state.

The service has `MemoryMax=150M` and `TasksMax=256`. The shipping service installs a cgroup-scoped netfilter owner before Node starts: loopback is allowed for the private network worker and local ingress, system DNS resolvers are allowed only on port 53, `api.ombhrum.com` addresses are allowed only on TCP/443, and every remaining service-owned packet reaches a final `REJECT` rule tagged `fdn-g15-official-device-mcp-egress`. IPv6 receives the same owner whenever the host has IPv6 enabled. The production probe validates the cgroup jump plus tagged reject rule, snapshots both IPv4/IPv6 counters before and after the five-minute window, exposes the delta as `unexpectedWorkerOwnedPacketsRejected`, and requires that delta to equal zero. Absence of the owner yields `BLOCKED_EGRESS_REJECT_COUNTER` and must never be recorded as passed G15 evidence.

## Report verdict regression acceptance

The verdict logic embedded in `fdn-network-coordinator/probe-official-device-mcp-g15.sh` is exercised by `node --test fdn-network-coordinator/probe-official-device-mcp-g15.test.mjs`. The test extracts and executes the actual Python report builder from the probe with synthetic environment inputs; it does not duplicate the verdict algorithm or access production hosts. Acceptance cases are:

- a missing egress owner or either counter snapshot/count produces `status=BLOCKED_EGRESS_REJECT_COUNTER`, `exitCode=78`, and never PASS when the other gates pass;
- a reported reject delta that disagrees with the start/end snapshots fails closed;
- observed privacy or resource-budget failures remain `FAIL` even when egress evidence is missing;
- `unexpectedWorkerOwnedPacketsRejected > 0` produces `FAIL` and a nonzero exit;
- privacy scan `fail` produces `FAIL` and a nonzero exit;
- each resource budget violation (RSS, CPU, state, audit, journal, disk reserve) produces `FAIL` and a nonzero exit;
- only zero unexpected rejected packets, a present counter, a passing privacy scan, and every resource budget within its documented bound produce `PASS` and exit 0.

The exact-HEAD GitHub Actions contract job must execute this regression suite for both pull requests and pushes affecting this production probe/spec/workflow. These synthetic verdict tests are not production G15 evidence.

Real resource evidence can only come from a workflow-dispatch run on deployed exact main with the production environment, after protected health/provenance and enrollment-key rotation gates are satisfied. No deployment, production G15 acceptance, or Desktop promotion may be inferred from these unit tests.
