import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountFactory, LeaseJournal, requireIsolation } from './factory.mjs';
import { verifyActionsIdentity } from './oidc.mjs';
import { CanonicalAuthAdapter } from './canonical-auth.mjs';
import { fixtureHandler } from './service.mjs';

const config = { environment: 'ci-isolated', authOrigin: 'https://auth-ci.example.net', allowedAuthOrigin: 'https://auth-ci.example.net', accountDbId: 'test-account-db', platformDbId: 'test-platform-db', mailboxResourceId: 'test-mailbox-id', productionResourceIds: ['production-inventory-id'] };
const identity = { repository: 'bhrumom/fabushi-backend', runId: '123', runAttempt: '1', sourceSha: 'a'.repeat(40) };
function fixture(options = {}) {
  const users = new Set();
  const journal = options.journal || new LeaseJournal(':memory:');
  const janitor = options.janitor || { async remove({ accounts }) { accounts.forEach(a => users.delete(a.username)); }, async inspect() { return { remaining: users.size }; } };
  const auth = options.auth || { async register(a) { users.add(a.username); }, async login(a) { return { accessToken: 'contract-access', refreshToken: 'contract-refresh', user: { id: a.username, username: a.username } }; } };
  return { users, journal, factory: new AccountFactory({ config, journal, auth, janitor, ...options }) };
}
test('planned A/B/C identities are distinct; A has two normal device sessions; journal contains no credentials', async () => {
  const { factory, journal } = fixture();
  const lease = await factory.create(identity, 'accounts');
  assert.equal(lease.accounts.length, 3);
  assert.equal(new Set(lease.accounts.map(a => a.username)).size, 3);
  assert.ok(lease.accounts.every(a => /^[A-Za-z0-9_-]{3,32}$/.test(a.username)));
  assert.equal(lease.accounts[0].sessions.length, 2);
  assert.equal(new Set(lease.accounts.flatMap(a => a.deviceIds)).size, 4);
  const row = JSON.stringify(journal.get(lease.leaseId));
  for (const account of lease.accounts) assert.ok(!row.includes(account.password));
  assert.ok(!row.includes('contract-access'));
  await factory.cleanup(identity, lease.leaseId);
  journal.close();
});
test('same run replay conflicts; run attempt and scenario isolate identities', async () => {
  const { factory, journal } = fixture();
  const a = await factory.create(identity, 'accounts');
  await assert.rejects(factory.create(identity, 'accounts'), /lease_already_allocated/);
  const b = await factory.create({ ...identity, runAttempt: '2' }, 'accounts');
  const c = await factory.create(identity, 'other');
  assert.equal(new Set([a, b, c].flatMap(l => l.accounts.map(u => u.username))).size, 9);
  journal.close();
});
test('cross-run cleanup denied before janitor; cleanup is idempotent', async () => {
  let calls = 0;
  const { factory, journal } = fixture({ janitor: { async remove() { calls++; }, async inspect() { return { remaining: 0 }; } } });
  const lease = await factory.create(identity, 'accounts');
  await assert.rejects(factory.cleanup({ ...identity, runId: '999' }, lease.leaseId), /lease_forbidden/);
  assert.equal(calls, 0);
  await factory.cleanup(identity, lease.leaseId);
  await factory.cleanup(identity, lease.leaseId);
  assert.equal(calls, 1);
  journal.close();
});
test('global quota counts allocating and failed cleanup leases', async () => {
  const { factory, journal } = fixture({ quota: 1, janitor: { async remove() { throw Error('failed'); }, async inspect() { return { remaining: 0 }; } } });
  const lease = await factory.create(identity, 'first');
  await assert.rejects(factory.cleanup(identity, lease.leaseId), /cleanup_failed/);
  await assert.rejects(factory.create(identity, 'second'), /quota_exceeded/);
  journal.close();
});
test('lost create response retains planned identity and removes partially created accounts', async () => {
  const planned = [];
  let cleanup;
  const { factory, journal } = fixture({ auth: { async register(a) { planned.push(a.username); throw Error('lost response'); }, async login() { assert.fail('cannot login'); } }, janitor: { async remove(a) { cleanup = a; }, async inspect() { return { remaining: 0 }; } } });
  await assert.rejects(factory.create(identity, 'partial'), /provision_failed/);
  assert.equal(cleanup.accounts.length, 3);
  assert.equal(cleanup.accounts[0].username, planned[0]);
  assert.equal(journal.get(cleanup.leaseId).state, 'cleaned');
  journal.close();
});
test('TTL persists over restart; residual cleanup fails closed and is retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-account-'));
  const path = join(dir, 'leases.sqlite');
  let time = 1000, remaining = 1;
  let journal = new LeaseJournal(path);
  const options = { now: () => time, ttlMs: 1000, janitor: { async remove() {}, async inspect() { return { remaining }; } } };
  let { factory } = fixture({ ...options, journal });
  const lease = await factory.create(identity, 'ttl');
  journal.close();
  assert.ok(!readFileSync(path).includes(Buffer.from(lease.accounts[0].password)));
  journal = new LeaseJournal(path);
  ({ factory } = fixture({ ...options, journal }));
  assert.deepEqual(await factory.sweep(), []);
  time = 2001;
  assert.equal((await factory.sweep())[0].status, 'blocked');
  assert.equal(journal.get(lease.leaseId).state, 'cleanup_failed');
  remaining = 0;
  assert.equal((await factory.sweep())[0].remaining, 0);
  journal.close();
  rmSync(dir, { recursive: true });
});
for (const change of [ { environment: 'production' }, { authOrigin: 'https://api.ombhrum.com', allowedAuthOrigin: 'https://api.ombhrum.com' }, { accountDbId: '7b6318f0-fbc2-42f9-9887-85f878ae76d0' }, { accountDbId: 'production-inventory-id' }, { authOrigin: 'http://auth-ci.example.net' }, { authOrigin: 'https://x:y@auth-ci.example.net' }, { productionResourceIds: [] }, { platformDbId: config.accountDbId } ]) {
  test(`reject unsafe isolation configuration ${JSON.stringify(change)}`, () => assert.throws(() => requireIsolation({ ...config, ...change })));
}
test('missing adapters reject; unsafe limits and scenarios reject', async () => {
  const journal = new LeaseJournal(':memory:');
  assert.throws(() => new AccountFactory({ config, journal }), /not_configured/);
  assert.throws(() => fixture({ ttlMs: 3600001 }), /invalid_limits/);
  const { factory, journal: j } = fixture();
  await assert.rejects(factory.create(identity, '../escape'), /invalid_scenario/);
  journal.close(); j.close();
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const claims = { iss: 'https://token.actions.githubusercontent.com', aud: 'fabushi-ci-fixtures', repository: identity.repository, repository_id: '123456', repository_owner_id: '98765', workflow_ref: 'bhrumom/fabushi-backend/.github/workflows/ci-account-factory-live.yml@refs/heads/main', ref: 'refs/heads/main', sub: `repo:${identity.repository}:environment:ci-isolated`, event_name: 'workflow_dispatch', sha: identity.sourceSha, run_id: identity.runId, run_attempt: identity.runAttempt, iat: 1000, nbf: 1000, exp: 1300 };
const policy = { audience: claims.aud, repository: claims.repository, repositoryId: claims.repository_id, ownerId: claims.repository_owner_id, workflowRefs: [claims.workflow_ref], refs: [claims.ref] };
const oidcOptions = { now: 1100000, fetchImpl: async (url, options) => { assert.equal(url, 'https://token.actions.githubusercontent.com/.well-known/jwks'); assert.equal(options.redirect, 'error'); return Response.json({ keys: [jwk] }); } };
function jwt(overrides = {}, headerOverrides = {}) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', ...headerOverrides })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString('base64url');
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}
test('OIDC verifies real RSA signature and immutable workflow/run identity', async () => assert.deepEqual(await verifyActionsIdentity(jwt(), policy, oidcOptions), identity));
test('OIDC accepts exact GitHub immutable-ID subject and rejects a different repository ID in that subject', async () => {
  const subject = 'repo:bhrumom@98765/fabushi-backend@123456:environment:ci-isolated';
  assert.deepEqual(await verifyActionsIdentity(jwt({ sub: subject }), policy, oidcOptions), identity);
  await assert.rejects(verifyActionsIdentity(jwt({ sub: subject.replace('@123456:', '@999999:') }), policy, oidcOptions), /oidc_denied/);
});
test('OIDC accepts an explicitly trusted Android consumer on main only', async () => {
  const androidClaims = {
    repository: 'fabu-android/fabushi-android', repository_id: '1375312939', repository_owner_id: '42258518',
    workflow_ref: 'fabu-android/fabushi-android/.github/workflows/android-parity-full-ci.yml@refs/heads/main',
    ref: 'refs/heads/main', sub: 'repo:fabu-android/fabushi-android:environment:ci-isolated',
  };
  const androidPolicy = { ...policy, trustedRepositories: [{ repository: androidClaims.repository, repositoryId: androidClaims.repository_id, ownerId: androidClaims.repository_owner_id, workflowRefs: [androidClaims.workflow_ref], refs: [androidClaims.ref] }] };
  assert.deepEqual(await verifyActionsIdentity(jwt(androidClaims), androidPolicy, oidcOptions), { ...identity, repository: androidClaims.repository });
  await assert.rejects(verifyActionsIdentity(jwt({ ...androidClaims, ref: 'refs/heads/feature' }), androidPolicy, oidcOptions), /oidc_denied/);
});
for (const overrides of [{ repository_id: 'other' }, { repository_owner_id: 'other' }, { repository: 'fork/repo' }, { aud: 'production' }, { iss: 'https://attacker.invalid' }, { workflow_ref: 'untrusted' }, { ref: 'refs/pull/1/merge' }, { event_name: 'pull_request_target' }, { event_name: 'pull_request' }, { exp: 1100 }, { nbf: 1200 }, { iat: 1200 }, { iat: 1 }, { run_attempt: '0' }, { sha: 'bad' }, { sub: 'repo:other:environment:ci-isolated' }]) {
  test(`OIDC denies claim mismatch ${JSON.stringify(overrides)}`, async () => assert.rejects(verifyActionsIdentity(jwt(overrides), policy, oidcOptions), /oidc_denied/));
}
test('OIDC rejects signature tampering and key URL/algorithm override', async () => {
  const token = jwt();
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...claims, run_id: '999' })).toString('base64url');
  await assert.rejects(verifyActionsIdentity(parts.join('.'), policy, oidcOptions), /oidc_denied/);
  for (const header of [{ alg: 'HS256' }, { jku: 'https://attacker.invalid/keys' }, { kid: 'unknown' }]) await assert.rejects(verifyActionsIdentity(jwt({}, header), policy, oidcOptions), /oidc_denied/);
});
test('factory endpoint requires signed OIDC and does not expose exception secrets', async () => {
  const { factory, journal } = fixture();
  const handler = fixtureHandler({ factory, policy, oidcOptions });
  assert.equal((await handler(new Request('https://fixture.invalid/v1/leases', { method: 'POST' }))).status, 401);
  assert.equal((await handler(new Request('https://fixture.invalid/v1/leases', { method: 'POST', headers: { authorization: `Bearer ${jwt()}` }, body: 'x'.repeat(513) }))).status, 400);
  const response = await handler(new Request('https://fixture.invalid/v1/leases', { method: 'POST', headers: { authorization: `Bearer ${jwt()}` }, body: JSON.stringify({ scenarioId: 'http' }) }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const lease = await response.json();
  assert.equal((await handler(new Request(`https://fixture.invalid/v1/leases/${lease.leaseId}`, { method: 'DELETE', headers: { authorization: `Bearer ${jwt({ run_id: '999' })}` } }))).status, 403);
  assert.equal((await handler(new Request(`https://fixture.invalid/v1/leases/${lease.leaseId}`, { method: 'DELETE', headers: { authorization: `Bearer ${jwt()}` } }))).status, 200);
  journal.close();
});
test('canonical adapter exercises normal registration/mailbox/poll/login and refuses a 200 rejected form', async () => {
  const calls = [];
  let status = 'completed';
  const adapter = new CanonicalAuthAdapter({ config, mailbox: { async receive({ email, attemptId }) { assert.equal(email, 'ci@ci.invalid'); assert.equal(attemptId, 'attempt-1'); return '123456'; } }, fetchImpl: async (url, options) => {
    assert.ok(url.startsWith(config.authOrigin)); assert.equal(options.redirect, 'error');
    calls.push([new URL(url).pathname, options]);
    if (url.endsWith('/start')) return Response.json({ attemptId: 'attempt-1', loginUrl: `${config.authOrigin}/api/auth/browser/portal?attemptId=attempt-1&ticket=secret-ticket`, pollSecret: 'poll-secret' });
    if (url.endsWith('/register/code')) return Response.json({ success: true });
    if (url.includes('/attempts/')) return Response.json({ status });
    if (url.endsWith('/login')) return Response.json({ user: { id: 1, username: 'ci-user' }, accessToken: 'contract-access', refreshToken: 'contract-refresh' });
    return new Response('form response');
  } });
  await adapter.register({ username: 'ci-user', email: 'ci@ci.invalid', password: 'contract-password', deviceIds: ['device-1'] });
  await adapter.login({ username: 'ci-user', password: 'contract-password', deviceId: 'device-2' });
  assert.deepEqual(calls.map(c => c[0]), ['/api/auth/browser/start', '/api/auth/browser/register/code', '/api/auth/browser/register', '/api/auth/browser/attempts/attempt-1', '/api/auth/login']);
  assert.equal(new URLSearchParams(calls[2][1].body).get('confirmPassword'), 'contract-password');
  status = 'pending';
  await assert.rejects(adapter.register({ username: 'ci-user', email: 'ci@ci.invalid', password: 'contract-password', deviceIds: ['device-1'] }), /registration_not_completed/);
});
test('canonical adapter rejects foreign attempt origin and mismatched authenticated user; no mutation retries', async () => {
  let calls = 0;
  const adapter = new CanonicalAuthAdapter({ config, mailbox: { async receive() { assert.fail(); } }, fetchImpl: async () => { calls++; return Response.json({ attemptId: 'a', loginUrl: 'https://attacker.invalid/?ticket=x', pollSecret: 'x' }); } });
  await assert.rejects(adapter.register({ deviceIds: ['a'] }), /invalid_auth_attempt/);
  assert.equal(calls, 1);
  await assert.rejects(adapter.login({ username: 'ci-user' }), /invalid_account_session/);
  const failing = new CanonicalAuthAdapter({ config, mailbox: { receive() {} }, fetchImpl: async () => { throw Error('secret transport error'); } });
  await assert.rejects(failing.request('/api/auth/login', {}));
});
