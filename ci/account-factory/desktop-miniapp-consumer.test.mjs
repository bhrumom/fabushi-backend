import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { requiredSteps, requiredChecks, validateCandidate } from './cloud/desktop-miniapp-candidate.mjs';
import { authOrigin, factoryOrigin, nativeSessionDescriptor, childEnvironment, verifyAccountEvidence, verifyRevokedSessions, waitForChildOutcome } from './cloud/desktop-miniapp-consumer.mjs';

function candidate() {
  const sha = 'a'.repeat(40); const digest = 'b'.repeat(64);
  return { sourceSha: sha, artifactId: '123', archiveSha: digest, version: '1.2.77', run: { id: 456, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', path: '.github/workflows/release-macos-main.yml', repository: { full_name: 'bhrumom/fabushi-desktop' }, head_repository: { full_name: 'bhrumom/fabushi-desktop' } }, artifact: { id: 123, expired: false, workflow_run: { id: 456, head_sha: sha }, digest: `sha256:${digest}`, name: `fabushi-macos-${sha.slice(0, 12)}`, size_in_bytes: 100 }, jobs: [{ steps: requiredSteps.map((name) => ({ name, conclusion: 'success' })) }], checks: requiredChecks.map((name) => ({ name, status: 'completed', conclusion: 'success' })) };
}
test('only the exact successful canonical-main signed candidate is accepted', () => {
  assert.equal(validateCandidate(candidate()).productionPackagedGatesVerified, true);
  for (const change of [
    (v) => { v.run.head_sha = 'c'.repeat(40); }, (v) => { v.run.head_branch = 'codex/unreviewed'; },
    (v) => { v.run.event = 'pull_request'; }, (v) => { v.run.conclusion = 'failure'; },
    (v) => { v.run.head_repository.full_name = 'outside/fork'; }, (v) => { v.run.path = '.github/workflows/other.yml'; },
    (v) => { v.artifact.expired = true; }, (v) => { v.artifact.workflow_run.id++; },
    (v) => { v.artifact.digest = `sha256:${'c'.repeat(64)}`; }, (v) => { v.artifact.name = 'other'; },
    (v) => { v.artifact.size_in_bytes = 2 ** 31; }, (v) => { v.version = '../escape'; },
    (v) => { v.artifactId = '9007199254740993'; },
  ]) { const value = candidate(); change(value); assert.throws(() => validateCandidate(value), /DFC_/); }
});
test('every required source and packaged gate must execute successfully', () => {
  for (const name of requiredSteps) {
    const v = candidate(); v.jobs[0].steps.find((step) => step.name === name).conclusion = 'skipped';
    assert.throws(() => validateCandidate(v), /DFC_PACKAGED_GATE_MISSING/);
  }
  for (const name of requiredChecks) {
    const v = candidate(); v.checks.find((check) => check.name === name).conclusion = 'neutral';
    assert.throws(() => validateCandidate(v), /DFC_SOURCE_CI_MISSING/);
  }
  const duplicate = candidate(); duplicate.checks.push({ name: requiredChecks[0], status: 'completed', conclusion: 'failure' });
  assert.throws(() => validateCandidate(duplicate), /DFC_SOURCE_CI_MISSING/);
});
const now = 1_900_000_000_000;
const ordinary = () => ({ username: 'ci_factory_A', deviceIds: ['factory-owned-device'], sessions: [{ accessToken: 'fixture-access-not-a-real-secret', refreshToken: 'fixture-refresh-not-a-real-secret', accessTokenExpiresAt: now + 60_000, user: { id: '123', username: 'ci_factory_A' } }] });
test('FIFO descriptor preserves ordinary identity and drops refresh/password material', () => {
  const raw = ordinary(); raw.password = 'fixture-password';
  const value = nativeSessionDescriptor(raw, 'A', { now, runId: '123', runAttempt: '1' });
  assert.equal(value.issuer, authOrigin); assert.equal(value.userId, '123'); assert.equal(value.ciRunner, true);
  assert.equal(value.sessionId, 'ci-runner:123:1:A');
  assert.equal(value.refreshToken, undefined); assert.equal(value.password, undefined);
  assert.equal(value.accessToken, raw.sessions[0].accessToken);
  assert.equal(value.accessTokenExpiresAt, now + 60_000);
});
test('malformed, expired, mixed-account and pre-exported sessions reject before delivery', () => {
  for (const change of [
    (a) => { a.sessions[0].user.username = 'different'; }, (a) => { a.sessions[0].user.id = ''; },
    (a) => { a.sessions[0].accessToken = 'tiny'; }, (a) => { a.sessions[0].accessTokenExpiresAt = now - 1; },
    (a) => { a.sessions[0].deviceId = 'other'; }, (a) => { a.sessions[0].refreshToken = ''; },
    (a) => { a.sessions[0].provider = 'github-actions'; }, (a) => { a.sessions[0].user.extra = 'x'.repeat(9000); },
  ]) { const a = ordinary(); change(a); assert.throws(() => nativeSessionDescriptor(a, 'A', { now, runId: '123', runAttempt: '1' }), /DFC_/); }
});
test('child cannot inherit OIDC, cloud, GitHub, SSH, passwords or runtime injection', () => {
  const value = childEnvironment({ ACTIONS_ID_TOKEN_REQUEST_URL: 'private', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private', CI_CLOUDFLARE_API_TOKEN: 'private', GH_TOKEN: 'private', FABUSHI_CI_TEST_PASSWORD: 'private', SSH_AUTH_SOCK: 'private', GITHUB_ENV: 'private', NODE_OPTIONS: 'private', NODE_TLS_REJECT_UNAUTHORIZED: '0', ELECTRON_RUN_AS_NODE: '1', GITHUB_SHA: 'public', PATH: '/usr/bin' }, { FABUSHI_CI_ACCOUNT_SESSION_FILE: '/private-ram/A.pipe' });
  assert.deepEqual(value, { GITHUB_SHA: 'public', PATH: '/usr/bin', FABUSHI_CI_ACCOUNT_SESSION_FILE: '/private-ram/A.pipe' });
});
test('two distinct real account and exact source evidence is mandatory', () => {
  const source = 'a'.repeat(40);
  const value = { sourceSha: source, harnessSource: source, issuerEnvironment: 'ci-isolated', sessionDelivery: 'private-fifo', accountA: '1'.repeat(64), accountB: '2'.repeat(64), realDepartureClosedWindow: true, distinctInstallations: true, distinctOrigins: true, retainedAccountASetting: true };
  assert.equal(verifyAccountEvidence(value, source), true);
  for (const field of ['realDepartureClosedWindow', 'distinctInstallations', 'distinctOrigins', 'retainedAccountASetting']) assert.throws(() => verifyAccountEvidence({ ...value, [field]: false }, source), /DFC_ACCOUNT_EVIDENCE_INVALID/);
  assert.throws(() => verifyAccountEvidence({ ...value, accountB: value.accountA }, source), /DFC_ACCOUNT_EVIDENCE_INVALID/);
  assert.throws(() => verifyAccountEvidence({ ...value, harnessSource: 'b'.repeat(40) }, source), /DFC_ACCOUNT_EVIDENCE_INVALID/);
  assert.throws(() => verifyAccountEvidence({ ...value, issuerEnvironment: 'production' }, source), /DFC_ACCOUNT_EVIDENCE_INVALID/);
  assert.throws(() => verifyAccountEvidence({ ...value, sessionDelivery: 'disk-json' }, source), /DFC_ACCOUNT_EVIDENCE_INVALID/);
});
test('factory routes stay isolated, memory delivery has no session JSON and cleanup is finally owned', () => {
  assert.notEqual(new URL(authOrigin).host, 'api.ombhrum.com');
  assert.notEqual(new URL(factoryOrigin).host, 'api.ombhrum.com');
  const source = readFileSync(new URL('./cloud/desktop-miniapp-consumer.mjs', import.meta.url), 'utf8');
  assert.match(source, /mkfifo/); assert.match(source, /0o700/); assert.match(source, /0o600/);
  assert.match(source, /ram:\/\/1048576/); assert.match(source, /finally/); assert.match(source, /result\.remaining !== 0/);
  assert.doesNotMatch(source, /writeFile\([^\n]*(descriptor|session|lease\.accounts)/i);
});
test('cleanup independently rejects both delivered ordinary sessions', () => {
  assert.equal(verifyRevokedSessions([401, 401]), true);
  for (const statuses of [[], [401], [401, 200], [200, 401], [401, 500], [401, 401, 401]]) assert.throws(() => verifyRevokedSessions(statuses), /DFC_CLEANUP_FAILED/);
});
test('bounded child timeout is explicitly uncertain and escalates termination without retry', async () => {
  const child = new EventEmitter();
  child.pid = 42;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') setImmediate(() => child.emit('exit', null, 'SIGKILL'));
    return true;
  };
  const result = await waitForChildOutcome(child, {
    timeoutMs: 5,
    terminationGraceMs: 5,
    killGraceMs: 5,
  });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.timedOut, true);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('child completion distinguishes confirmed success from failed and signalled outcomes', async () => {
  const child = () => {
    const value = new EventEmitter();
    value.pid = 42;
    value.kill = () => true;
    return value;
  };
  const success = child();
  setImmediate(() => success.emit('exit', 0, null));
  assert.equal((await waitForChildOutcome(success, { timeoutMs: 1000 })).outcome, 'success');

  const failure = child();
  setImmediate(() => failure.emit('exit', 17, null));
  assert.equal((await waitForChildOutcome(failure, { timeoutMs: 1000 })).outcome, 'failure');

  const signalled = child();
  setImmediate(() => signalled.emit('exit', null, 'SIGTERM'));
  assert.equal((await waitForChildOutcome(signalled, { timeoutMs: 1000 })).outcome, 'unknown');
});

test('a harness that never starts is distinguished from an unknown side-effect result', async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })));
  const result = await waitForChildOutcome(child, { timeoutMs: 1000 });
  assert.equal(result.outcome, 'not-started');
  assert.equal(result.errorName, 'Error');
});

test('a post-spawn child error remains uncertain and records its termination reason', async () => {
  const child = new EventEmitter();
  child.pid = 42;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGTERM') setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  };
  setImmediate(() => child.emit('error', Object.assign(new Error('child stream failed'), { code: 'EPIPE' })));
  const result = await waitForChildOutcome(child, {
    timeoutMs: 1000,
    terminationGraceMs: 50,
    killGraceMs: 50,
  });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationReason, 'child-error');
  assert.deepEqual(signals, ['SIGTERM']);
});

test('an unconfirmed hard kill remains unknown rather than implying completion', async () => {
  const child = new EventEmitter();
  child.pid = 42;
  const signals = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  const result = await waitForChildOutcome(child, {
    timeoutMs: 5,
    terminationGraceMs: 5,
    killGraceMs: 5,
  });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationUnconfirmed, true);
  assert.equal(result.terminationReason, 'timeout');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('factory evidence upload is an explicit safe allowlist and permissions stay consumer-scoped', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci-account-factory-cloud.yml', import.meta.url), 'utf8');
  const upload = workflow.split('name: desktop-miniapp-factory-')[1];
  assert.doesNotMatch(upload, /test-results|trace|appData|factory-private|^\s+desktop-evidence\/\s*$/m);
  assert.match(upload, /desktop-evidence\/factory-acceptance\.json/);
  assert.doesNotMatch(workflow.split('jobs:')[0], /actions: read/);
  const source = readFileSync(new URL('./cloud/desktop-miniapp-consumer.mjs', import.meta.url), 'utf8');
  assert.match(source, /SAND_APP_DATA_DIR: join\(volume, 'appData'\)/);
  assert.match(source, /SAND_TEMP_DIR: temporary/);
});


test('two-account descriptors remain disjoint and bound to each account identity', () => {
  const a = ordinary();
  const b = ordinary();
  b.username = 'ci_factory_B';
  b.deviceIds = ['factory-owned-device-B'];
  b.sessions[0].user = { id: '456', username: 'ci_factory_B' };
  b.sessions[0].accessToken = 'fixture-access-account-B-not-a-real-secret';
  b.sessions[0].refreshToken = 'fixture-refresh-account-B-not-a-real-secret';
  const descriptorA = nativeSessionDescriptor(a, 'A', { now, runId: '123', runAttempt: '1' });
  const descriptorB = nativeSessionDescriptor(b, 'B', { now, runId: '123', runAttempt: '1' });
  assert.notEqual(descriptorA.sessionId, descriptorB.sessionId);
  assert.notEqual(descriptorA.username, descriptorB.username);
  assert.notEqual(descriptorA.userId, descriptorB.userId);
  assert.notEqual(descriptorA.deviceId, descriptorB.deviceId);
  assert.notEqual(descriptorA.accessToken, descriptorB.accessToken);
  for (const mutate of [
    (value) => { value.sessions[0].user.username = 'ci_factory_A'; },
    (value) => { value.sessions[0].deviceId = 'factory-owned-device'; },
  ]) {
    const crossed = structuredClone(b);
    mutate(crossed);
    assert.throws(() => nativeSessionDescriptor(crossed, 'B', { now, runId: '123', runAttempt: '1' }), /DFC_/);
  }
});

test('revocation blocks both account sessions and restored A uses a fresh scoped descriptor', () => {
  assert.equal(verifyRevokedSessions([401, 401]), true);
  for (const statuses of [[401, 200], [200, 401], [401, 500]]) {
    assert.throws(() => verifyRevokedSessions(statuses), /DFC_CLEANUP_FAILED/);
  }
  const a = ordinary();
  const before = nativeSessionDescriptor(a, 'A', { now, runId: '123', runAttempt: '1' });
  const b = ordinary();
  b.username = 'ci_factory_B';
  b.deviceIds = ['factory-owned-device-B'];
  b.sessions[0].user = { id: '456', username: 'ci_factory_B' };
  b.sessions[0].accessToken = 'fixture-access-account-B-not-a-real-secret';
  b.sessions[0].refreshToken = 'fixture-refresh-account-B-not-a-real-secret';
  const duringB = nativeSessionDescriptor(b, 'B', { now, runId: '123', runAttempt: '1' });
  const restoredA = nativeSessionDescriptor(a, 'A', { now, runId: '124', runAttempt: '1' });
  assert.notEqual(before.sessionId, duringB.sessionId);
  assert.notEqual(duringB.sessionId, restoredA.sessionId);
  assert.equal(restoredA.username, before.username);
  assert.equal(restoredA.userId, before.userId);
  assert.equal(restoredA.deviceId, before.deviceId);
  const source = 'a'.repeat(40);
  const evidence = { sourceSha: source, harnessSource: source, issuerEnvironment: 'ci-isolated', sessionDelivery: 'private-fifo', accountA: '1'.repeat(64), accountB: '2'.repeat(64), realDepartureClosedWindow: true, distinctInstallations: true, distinctOrigins: true, retainedAccountASetting: true };
  assert.equal(verifyAccountEvidence(evidence, source), true);
  assert.throws(() => verifyAccountEvidence({ ...evidence, retainedAccountASetting: false }, source), /DFC_ACCOUNT_EVIDENCE_INVALID/);
});
