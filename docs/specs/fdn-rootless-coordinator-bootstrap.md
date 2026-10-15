# FDN rootless coordinator bootstrap
Status:active;owner:Backend FDN deployment;2026-10-15.
Parent:FDN-001 and fdn-network-coordinator/README.md.

## Problem,goal and scope
Controller SSH is configured but the approved server has no dedicated rootless
Docker/Headscale. Prepare this independent infrastructure using canonical source
and pinnedHeadscale0.29.5 with deny-all grants. No users,nodes,auth keys or accounts
are created. This is not a full healthy controller or real-network acceptance.

## Requirements
- RB01: Main-only protected-production Actions installs only the dedicated
  fabushi-fdn service account/rootless daemon. Preserve existing rootful workloads,
  host networking,VPN,DNS,firewall and legacy official MCP ingress.
- RB02: Missing uidmap/newuidmap/newgidmap may be installed from configured official
  OS packages. Use non-root setup tool,private XDG socket,systemd user service and
  linger. Service account must not join rootful docker group. Reserve65536 subuids
  and subgids only after overlap checks; retain any sufficient existing assignment.
- RB03: Render canonical Headscale config only in Actions for the reserved future
  HTTPS origin https://fdn.ombhrum.com. Do not publish DNS/ingress as part of this
  bootstrap. Bind HTTP8080 and metrics9090 to loopback; existing compose UDP3478 is
  deployed but firewall remains unchanged. Headscale admin remains local only.
- RB04: Immutable exact-SHA config releases under/opt/fabushi-fdn-infra; persistent
  rootless state under/var/lib/fabushi-fdn. Do not overwrite existing policy or keys
  on rerun. Atomic current release link and systemd oneshot manage canonical
  compose projectfabushi-fdn-coordinator. Account/cell-specific deployment is gated
  until actual authenticated identity and Core projections exist.
- RB05: Record exactsource/image,digest,rootless daemon running,actual container
  state and deployment exit in Actions. No private state,keys,authority or complete
  docker-info/log outputs in evidence. Missing image/packages/userbus is blocked.

## Architecture and failure modes
Reuse canonicalHeadscale compose/config/render/policy owners. Existing rootless
Docker setup executable was read on server; it supports install --force. Existing
rootful Docker remains active. Missingnewuidmap prevents installation untiluidmap
package installed. A conflicting subordinateID range or nonempty incompatible
state stops. No non-root Docker fallback and no rootful socket grant.

## Plan and verification
Specfirst -> installer + protectedActions workflow -> Actions shell syntax and
existingHeadscale config contracts -> merge -> explicit mainbootstrap -> actual
service state evidence. No tests/builds/generators on personal devices. Server
commands are production administration/runtime startup only; all rendering,
static/config verification and acceptance orchestration run in Actions.

## Acceptance and compliance
| ID | Status | Evidence |
| --- | --- | --- |
| RB01–05 | blocked | Implementation and exact-source Actions pending |
| AC1 rootless daemon dedicated and Headscale running | blocked | Actual deployment pending |
| AC2 public control origin/DERP usable | blocked | DNS/ingress/firewall/node enrollment separate |
| AC3 full7inputs and production MCP | blocked | Cell identity,worker enrollment,fixture scope still required |

## Rollback and provenance
Stop onlyfabushi-fdn-headscale.service and this user's docker.service to pause;
do not delete volumes or revoke keys automatically. Preserve previous config
release and deny-all policy. Other services unaffected. References:rootless Docker
official documentation https://docs.docker.com/engine/security/rootless/;
canonical0.29.5 compose/README;authenticated serverinventory2026-10-15.

## RB06 source-preserving STUN repair (2026-10-15)
Actual external run38696389447 now receives a valid STUN response but correctly
fails stun_mapping_invalid. The dedicated daemon uses RootlessKit2.3.4 builtin
port driver and Docker28.4.0; source IP is rewritten at this forwarding boundary,
so STUN cannot report the external runner's real mapped address. Do not weaken
public-address validation or treat a private mapped address as direct readiness.
Install a dedicated fabushi-fdn docker.service user drop-in selecting existing
slirp4netns1.2.1 for both network and port drivers. Restart only this dedicated
rootless daemon if the drop-in changes; preserve rootful daemon, state, policy,
keys, public port scopes and every other instance/service. No host networking or
additional public access. Config/deployment only from protected-main Actions;
real external probe must pass with globally routable mapped IPv4 before RB06 is
accepted. Reverting only this owned drop-in/restoring the dedicated daemon pauses
this rollout; never delete state. Missing slirp4netns blocks without fallback.
Reference: Docker official troubleshooting, source IP propagation for prior
RootlessKit versions: https://docs.docker.com/engine/security/rootless/troubleshoot/ .
