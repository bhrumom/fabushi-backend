import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ACCOUNT = 'c9b14ac29b7815a5fcc704799d1a0f25';
const WORKER = 'mahayana-platform';
const SECRET = 'FDN_NETWORK_AUTHORITY_TOKEN';
const CORE = 'https://mahayana-platform.bhrumom.workers.dev';
const CELL = 'cell-fdn-bootstrap-readonly';
const STAGE = '/etc/fabushi/fdn-authority-bootstrap.env';
const fail = code => { throw new Error(code); };
export function plan(corePresent, stagePresent, bootstrap) {
  if (!bootstrap) return 'preflight-only';
  if (corePresent && !stagePresent) fail('existing_authority_without_server_material');
  if (corePresent) return 'reconcile-existing';
  return stagePresent ? 'publish-staged' : 'initialize-once';
}
export function generateAuthority() { return randomBytes(48).toString('hex'); }
export async function publishOnce(fetchImpl, url, apiToken, authority) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: SECRET, text: authority, type: 'secret_text' }) });
  } catch { fail('authority_publish_outcome_unknown'); }
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) fail('authority_publish_rejected');
}
export function publicError(error) {
  const allowed = new Set(['actions_main_only','missing_configuration','cloud_settings_unavailable','cloud_settings_invalid','ssh_inventory_unavailable','existing_authority_without_server_material','unsafe_stage_path','invalid_staged_authority','stage_write_failed','authority_publish_outcome_unknown','authority_publish_rejected','core_route_unavailable','core_authority_rejected','core_snapshot_invalid']);
  return allowed.has(error?.message) ? error.message : 'authority_bootstrap_failed';
}
async function main() {
  const report = { sourceSha: process.env.GITHUB_SHA, coreSourceSha: process.env.CORE_SHA,
    runId: process.env.GITHUB_RUN_ID, mode: process.env.BOOTSTRAP === 'true' ? 'bootstrap' : 'preflight', overall: 'FAIL', exitCode: 1 };
  mkdirSync('evidence', { recursive: true });
  try {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') fail('actions_main_only');
    const apiToken = process.env.CF_BOOTSTRAP_TOKEN;
    const host = process.env.DEPLOY_HOST, user = process.env.DEPLOY_USER;
    if (!apiToken || !host || !user || !/^[a-z_][a-z0-9_-]*$/.test(user) || !/^[a-zA-Z0-9.-]+$/.test(host)) fail('missing_configuration');
    const ssh = (command, input) => execFileSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=15',`${user}@${host}`,command], { encoding: 'utf8', input, timeout: 30000, stdio: ['pipe','pipe','pipe'] });
    const settingsUrl = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/settings`;
    let settingsResponse;
    try { settingsResponse = await fetch(settingsUrl, { headers: { authorization: `Bearer ${apiToken}` }, redirect:'error', signal:AbortSignal.timeout(15000) }); }
    catch { fail('cloud_settings_unavailable'); }
    if (!settingsResponse.ok) fail('cloud_settings_unavailable');
    const settings = await settingsResponse.json().catch(() => null);
    if (settings?.success !== true || !Array.isArray(settings.result?.bindings)) fail('cloud_settings_invalid');
    report.cloudWorkerSettingsReadable = true;
    const corePresent = settings.result.bindings.some(b => b.name === SECRET);
    let stagePresence;
    try { stagePresence = ssh(`sudo test ! -L ${STAGE} && if sudo test -f ${STAGE}; then printf configured; else printf absent; fi`).trim(); }
    catch { fail('ssh_inventory_unavailable'); }
    if (!['configured','absent'].includes(stagePresence)) fail('unsafe_stage_path');
    const stagePresent = stagePresence === 'configured';
    report.coreAuthorityConfigured = corePresent; report.serverAuthorityStaged = stagePresent;
    report.action = plan(corePresent, stagePresent, process.env.BOOTSTRAP === 'true');
    const snapshot = authority => fetch(`${CORE}/v1/internal/computers/network-bindings/cell-snapshot`, { method:'POST', redirect:'error', signal:AbortSignal.timeout(15000), headers:{'content-type':'application/json', ...(authority ? {'x-fabushi-network-authority':authority} : {})}, body:JSON.stringify({cellId:CELL}) });
    const unauth = await snapshot();
    report.unauthenticatedStatus = unauth.status;
    await unauth.body?.cancel();
    if (unauth.status !== 401) fail('core_route_unavailable');
    if (report.action !== 'preflight-only') {
      let authority;
      if (stagePresent) {
        try { authority = ssh(`sudo test ! -L ${STAGE} && sudo cat ${STAGE}`).trim().replace(/^FDN_NETWORK_AUTHORITY_TOKEN=/,''); }
        catch { fail('ssh_inventory_unavailable'); }
      } else {
        authority = generateAuthority();
        try { ssh(`sudo sh -c 'set -eu; umask 077; install -d -m 0755 /etc/fabushi; test ! -e ${STAGE}; set -C; cat > ${STAGE}; chmod 0600 ${STAGE}'`, `${SECRET}=${authority}\n`); }
        catch { fail('stage_write_failed'); }
        report.serverAuthorityStaged = true;
      }
      if (!/^[a-f0-9]{96}$/.test(authority)) fail('invalid_staged_authority');
      if (!corePresent) await publishOnce(fetch, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/secrets`, apiToken, authority);
      // Read-only reconciliation, never re-publish or generate on unknown outcome.
      const accepted = await snapshot(authority);
      report.authenticatedStatus = accepted.status;
      if (!accepted.ok) { await accepted.body?.cancel(); fail('core_authority_rejected'); }
      const result = await accepted.json().catch(() => null);
      if (result?.cellId !== CELL || !Array.isArray(result.bindings) || result.bindings.length !== 0) fail('core_snapshot_invalid');
      report.coreAuthorityConfigured = true; report.authorityReconciled = true;
    }
    report.overall = 'PASS'; report.exitCode = 0;
  } catch (error) { report.error = publicError(error); process.exitCode = 1; }
  finally {
    writeFileSync('evidence/fdn-authority-bootstrap.json', JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
