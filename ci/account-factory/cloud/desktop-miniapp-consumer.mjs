import { constants } from 'node:fs';
import { open, mkdir, readFile, readdir, lstat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const factoryOrigin = 'https://fabushi-ci-isolated-accounts.bhrumom.workers.dev';
export const authOrigin = 'https://fabushi-ci-isolated-auth.bhrumom.workers.dev';
export const factorySha = '4ccf4f31ce035b19a0b697828f091d320e04b77b';
export const coreSha = 'c7d0e24b7561c6f5d1bb3c0e975f599643252504';
const fail = (code) => { throw Error(code); };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export function nativeSessionDescriptor(account, label, { runId, runAttempt, now = Date.now() } = {}) {
  const session = account?.sessions?.[0];
  if (!/^[0-9]+$/.test(runId || '') || !/^[0-9]+$/.test(runAttempt || '') || !/^[AB]$/.test(label || '') || !session?.user || session.user.username !== account.username || !/^[A-Za-z0-9_-]{3,32}$/.test(account.username || '') || !/^[A-Za-z0-9._:-]{1,200}$/.test(String(session.user.id ?? '')) || typeof session.accessToken !== 'string' || session.accessToken.length < 24 || session.accessToken.length > 16_384 || /\s/.test(session.accessToken) || typeof session.refreshToken !== 'string' || !session.refreshToken || session.provider === 'github-actions' || session.ciRunner === true) fail('DFC_ORDINARY_SESSION_INVALID');
  let expires = Number(session.accessTokenExpiresAt);
  // Expiry is client scheduling metadata, not token authentication. The normal
  // isolated user-info endpoint independently validates each ordinary bearer.
  if (!Number.isFinite(expires)) {
    try { expires = JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url').toString('utf8')).exp; }
    catch { fail('DFC_SESSION_EXPIRY_INVALID'); }
  }
  const expiryMs = expires < 10_000_000_000 ? expires * 1000 : expires;
  const deviceId = account.deviceIds?.[0];
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= now + 30_000 || expiryMs > now + 5 * 60 * 60_000 || typeof deviceId !== 'string' || !deviceId || deviceId.length > 200 || (session.deviceId && session.deviceId !== deviceId)) fail('DFC_SESSION_EXPIRY_INVALID');
  const descriptor = { accessToken: session.accessToken, accessTokenExpiresAt: expiryMs, sessionId: `ci-runner:${runId}:${runAttempt}:${label}`, deviceId, username: account.username, userId: String(session.user.id), user: session.user, issuer: authOrigin, provider: 'github-actions', ciRunner: true };
  if (Buffer.byteLength(JSON.stringify(descriptor)) > 8 * 1024) fail('DFC_SESSION_DELIVERY_OVERSIZE');
  return descriptor;
}

export function childEnvironment(input, additions) {
  const result = Object.fromEntries(Object.entries(input).filter(([name]) => !/TOKEN|PASSWORD|SECRET|CREDENTIAL|^SSH_|^AWS_|^GITHUB_(ENV|OUTPUT|STATE)$|^NODE_(OPTIONS|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)$|^ELECTRON_/i.test(name)));
  return { ...result, ...additions };
}

export function verifyAccountEvidence(value, sourceSha) {
  if (value?.sourceSha !== sourceSha || value.harnessSource !== sourceSha || !/^[a-f0-9]{64}$/.test(value.accountA || '') || !/^[a-f0-9]{64}$/.test(value.accountB || '') || value.accountA === value.accountB || value.realDepartureClosedWindow !== true || value.distinctInstallations !== true || value.distinctOrigins !== true || value.retainedAccountASetting !== true) fail('DFC_ACCOUNT_EVIDENCE_INVALID');
  return true;
}

async function fifoDelivery(path, descriptor) {
  execFileSync('/usr/bin/mkfifo', ['-m', '600', path], { stdio: 'pipe' });
  const info = await lstat(path);
  if (!info.isFIFO() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()) fail('DFC_PIPE_PRIVACY');
  const bytes = Buffer.from(JSON.stringify(descriptor));
  let stopped = false; let failed = false;
  const running = (async () => {
    while (!stopped) {
      let handle;
      try {
        handle = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
        await handle.writeFile(bytes);
      } catch (error) {
        if (error.code !== 'ENXIO' && !(stopped && error.code === 'ENOENT')) { failed = true; break; }
      } finally { await handle?.close(); }
      await pause(100);
    }
  })();
  return { failed: () => failed, async close() { stopped = true; await running; bytes.fill(0); await unlink(path); } };
}

function verifyRamVolume() {
  const volume = process.env.DFC_RAM_VOLUME;
  const device = process.env.DFC_RAM_DEVICE;
  const name = `FabushiLease-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  if (volume !== `/Volumes/${name}` || !/^\/dev\/disk[0-9]+$/.test(device || '')) fail('DFC_RAM_NOT_CONFIGURED');
  const jsonPlist = (command, args) => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: execFileSync(command, args), encoding: 'utf8' }));
  const mounted = jsonPlist('/usr/sbin/diskutil', ['info', '-plist', volume]);
  const images = jsonPlist('/usr/bin/hdiutil', ['info', '-plist']);
  if (mounted.MountPoint !== volume || mounted.VolumeName !== name || mounted.DeviceNode !== device || !images.images?.some((image) => image['image-path'] === 'ram://1048576' && image['system-entities']?.some((entity) => entity['dev-entry'] === device))) fail('DFC_RAM_IDENTITY_INVALID');
  return volume;
}

export async function runConsumer() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || process.platform !== 'darwin') fail('DFC_RUNNER_DENIED');
  const sourceSha = process.env.OBF_SOURCE_SHA;
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '') || execFileSync('git', ['-C', 'desktop-source', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceSha || execFileSync('git', ['-C', 'desktop-source', 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) fail('DFC_HARNESS_SOURCE_INVALID');
  const candidate = JSON.parse(await readFile('desktop-evidence/candidate.json', 'utf8'));
  if (candidate.desktopSourceSha !== sourceSha || candidate.productionPackagedGatesVerified !== true || candidate.sourceCiVerified !== true) fail('DFC_CANDIDATE_NOT_ACCEPTED');
  const volume = verifyRamVolume();
  const privateRoot = join(volume, 'factory-private'); const temporary = join(volume, 'tmp');
  await mkdir(privateRoot, { mode: 0o700 }); await mkdir(temporary, { mode: 0o700 });
  const report = { kind: 'signed-desktop-miniapp-account-factory', consumerBackendSha: process.env.GITHUB_SHA, factoryBackendSha: factorySha, factoryCoreSha: coreSha, desktopSourceSha: sourceSha, binarySourceSha: sourceSha, harnessSourceSha: sourceSha, artifactId: candidate.artifactId, archiveSha256: candidate.archiveSha256, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, stage: 'health', overall: 'FAIL', assertions: {} };
  let lease; let sessionA; let deliveries = []; let testPassed = false; let cleanupPassed = false;
  async function oidc() {
    const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL); url.searchParams.set('audience', factoryOrigin);
    const response = await fetch(url, { headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) fail('DFC_OIDC_UNAVAILABLE');
    const body = await response.json(); if (typeof body.value !== 'string' || !body.value) fail('DFC_OIDC_UNAVAILABLE');
    return body.value;
  }
  async function fixture(path, method, body) {
    return fetch(`${factoryOrigin}${path}`, { method, headers: { authorization: `Bearer ${await oidc()}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(180_000) });
  }
  const userInfo = (session) => fetch(`${authOrigin}/api/auth/user-info`, { headers: { authorization: `Bearer ${session.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  try {
    const health = await (await fetch(`${factoryOrigin}/health`, { redirect: 'error', signal: AbortSignal.timeout(15_000) })).json();
    if (health.backendSha !== factorySha || health.coreSha !== coreSha) fail('DFC_FACTORY_SOURCE_MISMATCH');
    report.assertions.acceptedFactorySource = true; report.stage = 'lease';
    const allocated = await fixture('/v1/leases', 'POST', { scenarioId: `desktop-miniapp-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}` });
    if (allocated.status !== 201) fail('DFC_ALLOCATION_FAILED');
    lease = await allocated.json();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(lease.leaseId || '') || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= Date.now() + 60_000 || !Array.isArray(lease.accounts) || lease.accounts.length !== 3) fail('DFC_LEASE_INVALID');
    const [a, b] = lease.accounts;
    const descriptors = [nativeSessionDescriptor(a, 'A', { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT }), nativeSessionDescriptor(b, 'B', { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT })];
    if (descriptors[0].userId === descriptors[1].userId) fail('DFC_IDENTITIES_NOT_DISTINCT');
    for (const account of [a, b]) {
      const response = await userInfo(account.sessions[0]); const data = await response.json();
      if (response.status !== 200 || String(data.id ?? data.user?.id) !== String(account.sessions[0].user.id)) fail('DFC_LIVE_IDENTITY_REJECTED');
    }
    sessionA = a.sessions[0];
    const pipes = ['A', 'B'].map((label) => join(privateRoot, `${label}.pipe`));
    for (let index = 0; index < pipes.length; index++) deliveries.push(await fifoDelivery(pipes[index], descriptors[index]));
    report.assertions.realDistinctOrdinaryAccounts = true; report.stage = 'signed-ui';
    const output = resolve('desktop-evidence/runtime'); await mkdir(output, { recursive: true });
    const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'e2e/miniapp-packaged-acceptance.spec.ts', '--workers=1', '--grep', 'real account departure and two-account'], {
      cwd: resolve('desktop-source/desktop'), stdio: 'inherit',
      env: childEnvironment(process.env, { FABUSHI_API_BASE_URL: authOrigin, FABUSHI_ACCOUNT_ENVIRONMENT: 'ci-isolated', FABUSHI_CI_ACCOUNT_SESSION_FILE: pipes[0], FABUSHI_CI_SECOND_ACCOUNT_SESSION_FILE: pipes[1], FABUSHI_CI_SESSION_DELIVERY: 'private-fifo', FABUSHI_MINIAPP_HARNESS_SOURCE: sourceSha, FABUSHI_NATIVE_APP_DATA_ROOT: join(volume, 'appData'), TMPDIR: temporary, MINIAPP_REAL_ACCEPTANCE: '1', MINIAPP_ACCOUNT_SWITCH_ACCEPTANCE: '1', MINIAPP_EVIDENCE_DIR: output, FABUSHI_FEATURE_HOST_MODE: 'production', FABUSHI_E2E: '0' }),
    });
    const abort = () => child.kill('SIGTERM'); process.once('SIGTERM', abort); process.once('SIGINT', abort);
    let status;
    try { status = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject); }); }
    finally { process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort); }
    report.harnessExitCode = status;
    if (status !== 0 || deliveries.some((delivery) => delivery.failed())) fail('DFC_SIGNED_UI_FAILED');
    const runs = (await readdir(output)).filter((name) => name.startsWith('account-switch-'));
    if (runs.length !== 1) fail('DFC_ACCOUNT_EVIDENCE_AMBIGUOUS');
    verifyAccountEvidence(JSON.parse(await readFile(join(output, runs[0], 'account-isolation.json'), 'utf8')), sourceSha);
    report.assertions.signedRealAccountTransition = true; testPassed = true;
  } catch (error) {
    report.failureCode = /^DFC_[A-Z_]+$/.test(error.message || '') ? error.message : 'DFC_CONSUMER_FAILED';
  } finally {
    report.stage = 'cleanup';
    for (const delivery of deliveries) { try { await delivery.close(); } catch { report.pipeCleanupFailed = true; } }
    if (lease?.leaseId && /^[A-Za-z0-9_-]{1,200}$/.test(lease.leaseId)) {
      try {
        const response = await fixture(`/v1/leases/${lease.leaseId}`, 'DELETE'); const result = await response.json();
        if (response.status !== 200 || result.remaining !== 0 || !sessionA || (await userInfo(sessionA)).status !== 401) fail('DFC_CLEANUP_FAILED');
        report.assertions.zeroOwnedResidueAndRevocation = true; cleanupPassed = true;
      } catch { report.cleanup = 'blocked'; }
    }
    report.stage = 'complete';
    report.overall = testPassed && cleanupPassed && !report.pipeCleanupFailed ? 'PASS' : 'FAIL';
    report.assertionCount = Object.keys(report.assertions).length;
    await writeFile('desktop-evidence/factory-acceptance.json', JSON.stringify(report, null, 2));
    if (report.overall !== 'PASS') process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runConsumer(); }
  catch (error) { console.error(/^DFC_[A-Z_]+$/.test(error.message || '') ? error.message : 'DFC_CONSUMER_FAILED'); process.exitCode = 1; }
}
