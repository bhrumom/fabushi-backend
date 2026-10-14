// Actual canonical wasm Worker integration with emulated local D1, never a
// deployed-cloud or packaged-app pass. This entrypoint is Actions-only.
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { LeaseJournal, AccountFactory } from './factory.mjs';
import { CanonicalAuthAdapter } from './canonical-auth.mjs';
import { fixtureHandler } from './service.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN) throw Error('actions_isolation_required');
const dir = join(process.env.RUNNER_TEMP, 'account-worker');
const configPath = join(dir, 'wrangler.json');
const workerConfig = JSON.parse(readFileSync(configPath));
const workerVars = JSON.parse(readFileSync(join(dir, 'worker-vars.json')));
const wrangler = join(process.env.RUNNER_TEMP, 'fixture-tools/node_modules/.bin/wrangler');
const state = join(dir, 'state');
function sql(command) {
  const sqlPath = join(dir, 'operation.sql');
  writeFileSync(sqlPath, command, { mode: 0o600 });
  const output = execFileSync(wrangler, ['d1', 'execute', 'ACCOUNT_DB', '--local', '--persist-to', state, '--config', configPath, '--json', '--file', sqlPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  const results = JSON.parse(output);
  assert.ok(results.every(r => r.success));
  return results.flatMap(r => r.results);
}
const escape = v => `'${String(v).replaceAll("'", "''")}'`;
const emails = new Map();
const servers = [];
const listen = server => new Promise((ok, fail) => { server.once('error', fail); server.listen(server.fixturePort, '127.0.0.1', ok); });
const mailboxServer = httpServer(async (req, res) => {
  const headers = Object.entries(req.headers);
  if (!headers.some(([k, v]) => k.includes('bridge') && v === workerVars.AUTH_PROVIDER_BRIDGE_SECRET)) { res.writeHead(403).end(); return; }
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/internal/auth-provider/capabilities') { res.end(JSON.stringify({ email: true, alipay: false })); return; }
  if (req.method === 'POST' && req.url === '/api/internal/auth-provider/email/send-registration-code') {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413).end(); return; } }
    const { email, code } = JSON.parse(body);
    if (!email.endsWith('@ci.invalid') || !/^\d{6}$/.test(code)) { res.writeHead(400).end(); return; }
    emails.set(email, code); res.end('{"ok":true}'); return;
  }
  res.writeHead(404).end('{}');
});
mailboxServer.fixturePort = 9444;
servers.push(mailboxServer);
const proxy = httpsServer({ key: readFileSync(join(dir, 'tls-key.pem')), cert: readFileSync(join(dir, 'tls-cert.pem')) }, async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const response = await fetch(`http://127.0.0.1:8787${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const responseHeaders = Object.fromEntries(response.headers);
    // fetch() already decompresses the upstream body. Do not instruct the
    // downstream client to decompress again or trust the compressed length.
    for (const name of ['content-encoding', 'content-length', 'transfer-encoding']) delete responseHeaders[name];
    responseHeaders.connection = 'close';
    res.writeHead(response.status, responseHeaders); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(502).end('proxy_failed'); }
});
proxy.fixturePort = 9443; servers.push(proxy);
let worker, journal, factory, handler, oidc, lease;
let startupOutput = '';
function printRuntimeErrors() {
  let redacted = startupOutput;
  for (const value of Object.values(workerVars)) redacted = redacted.replaceAll(value, '[redacted]').replaceAll(JSON.stringify(value), '[redacted]');
  console.error(redacted.split('\n').filter(line => /error|invalid|failed|cannot|could|ENOENT/i.test(line) && !/PRIVATE_KEY|BRIDGE_SECRET|PUBLIC_KEY/.test(line)).slice(-30).join('\n'));
}
const assertions = {};
const evidence = { kind: 'canonical-worker-runtime-integration', backendSha: process.env.GITHUB_SHA, coreSha: process.env.CORE_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, d1Mode: 'emulated-local', hostedFixtureService: 'NOT_VERIFIED', packagedCrossDeviceE2E: 'NOT_VERIFIED', assertions, overall: 'FAIL' };
try {
  sql(readFileSync('fabushi/web/schema.sql', 'utf8') + '\nALTER TABLE users ADD COLUMN user_no INTEGER;');
  for (const name of ['0001_account_auth.sql', '0002_oauth_identities.sql', '0003_oauth_attempt_failed_status.sql', '0004_email_registration_challenges.sql', '0005_principals_connections.sql', '0006_mcp_connection_oauth.sql', '0007_service_delegations.sql']) sql(readFileSync(resolve('core/third_party/mahayana/mahayana-rs/mahayana-platform-worker/account-migrations', name), 'utf8'));
  await Promise.all(servers.map(listen));
  // No secret-bearing config or raw runtime logs are uploaded.
  worker = spawn(wrangler, ['dev', '--local', '--port', '8787', '--ip', '127.0.0.1', '--persist-to', state, '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = data => { if (startupOutput.length < 262144) startupOutput += data.toString(); };
  worker.stdout.on('data', capture); worker.stderr.on('data', capture);
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try { const r = await fetch('https://127.0.0.1:9443/health', { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!ready) {
    printRuntimeErrors();
  }
  assert.ok(ready, 'canonical Worker did not start');
  const config = { environment: 'ci-isolated', authOrigin: 'https://127.0.0.1:9443', allowedAuthOrigin: 'https://127.0.0.1:9443', accountDbId: workerConfig.d1_databases[0].database_id, platformDbId: workerConfig.d1_databases[1].database_id, mailboxResourceId: 'runner-only-mailbox', productionResourceIds: ['production-resources-denied'] };
  const janitor = {
    async remove({ accounts }) {
      for (const a of accounts) {
        const users = sql(`SELECT id FROM users WHERE username=${escape(a.username)} AND email=${escape(a.email)}`);
        for (const u of users) {
          const id = escape(String(u.id));
          sql(`DELETE FROM account_refresh_tokens WHERE session_id IN (SELECT session_id FROM account_sessions WHERE user_id=${id}); DELETE FROM account_auth_events WHERE user_id=${id}; DELETE FROM account_sessions WHERE user_id=${id}; DELETE FROM account_password_credentials WHERE user_id=${id}; DELETE FROM account_contact_points WHERE principal_id IN (SELECT principal_id FROM account_principals WHERE legacy_user_id=${id}); DELETE FROM account_identity_principals WHERE principal_id IN (SELECT principal_id FROM account_principals WHERE legacy_user_id=${id}); DELETE FROM account_principals WHERE legacy_user_id=${id}; DELETE FROM email_username_mapping WHERE username=${escape(a.username)}; DELETE FROM users WHERE id=${u.id} AND username=${escape(a.username)} AND email=${escape(a.email)};`);
        }
        sql(`DELETE FROM account_email_challenges WHERE email=${escape(a.email)}; DELETE FROM account_oauth_attempts WHERE device_id IN (${a.deviceIds.map(escape).join(',')});`);
        emails.delete(a.email);
      }
    },
    async inspect() {
      const tables = ['users', 'email_username_mapping', 'account_password_credentials', 'account_sessions', 'account_refresh_tokens', 'account_auth_events', 'account_email_challenges', 'account_oauth_attempts', 'account_principals', 'account_identity_principals', 'account_contact_points'];
      // This entire DB is unique to the one disposable runtime run. Counting
      // every row also detects orphan references, not just leftover users.
      return { remaining: tables.reduce((sum, table) => sum + sql(`SELECT count(*) AS n FROM ${table}`)[0].n, emails.size) };
    },
  };
  const auth = new CanonicalAuthAdapter({ config, mailbox: { async receive({ email }) { const code = emails.get(email); if (!code) throw Error('mail_not_delivered'); emails.delete(email); return code; } }, fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    try { const r = await fetch(url, { ...options, headers: { ...options.headers, connection: 'close' } }); console.log(`Canonical auth route ${path}: HTTP ${r.status}`); return r; }
    catch { console.error(`Canonical auth route ${path}: transport_failed`); throw Error('transport_failed'); }
  } });
  journal = new LeaseJournal(join(dir, 'leases.sqlite'));
  let factoryTime = Date.now();
  factory = new AccountFactory({ config, journal, auth, janitor, now: () => factoryTime });
  const audience = 'fabushi-ci-fixtures';
  const oidcUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL); oidcUrl.searchParams.set('audience', audience);
  const oidcResponse = await fetch(oidcUrl, { headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: 'error' });
  assert.ok(oidcResponse.ok); oidc = (await oidcResponse.json()).value;
  handler = fixtureHandler({ factory, oidcOptions: { fetchImpl: (url, options) => fetch(url, { ...options, headers: { connection: 'close' } }) }, policy: { audience, repository: process.env.GITHUB_REPOSITORY, repositoryId: process.env.REPOSITORY_ID, ownerId: process.env.REPOSITORY_OWNER_ID, workflowRefs: [`${process.env.GITHUB_REPOSITORY}/.github/workflows/ci-account-factory-runtime.yml@${process.env.GITHUB_REF}`], refs: [process.env.GITHUB_REF] } });
  const fixtureRequest = (path, method, body, token = oidc) => handler(new Request(`https://fixture.invalid${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }));
  assert.equal((await fixtureRequest('/v1/leases', 'POST', { scenarioId: 'actual-worker' }, 'invalid')).status, 401);
  assertions.oidcInvalidRejected = 'PASS';
  const created = await fixtureRequest('/v1/leases', 'POST', { scenarioId: 'actual-worker' });
  if (created.status === 401) {
    // Diagnostic allowlist only; decoded claims never authorize the request.
    const h = JSON.parse(Buffer.from(oidc.split('.')[0], 'base64url'));
    const p = JSON.parse(Buffer.from(oidc.split('.')[1], 'base64url'));
    console.error(JSON.stringify({ oidcDiagnostic: { alg: h.alg, hasJku: !!h.jku, hasX5u: !!h.x5u, hasCrit: !!h.crit, iss: p.iss, aud: p.aud, repository: p.repository, repository_id: p.repository_id, repository_owner_id: p.repository_owner_id, workflow_ref: p.workflow_ref, ref: p.ref, sub: p.sub, event_name: p.event_name, run_id: p.run_id, run_attempt: p.run_attempt, sha: p.sha, lifetimeSeconds: p.exp - p.iat, issuedAgoSeconds: Math.floor(Date.now() / 1000) - p.iat } }));
  }
  const payload = await created.json(); if (!created.ok) printRuntimeErrors(); assert.equal(created.status, 201, `fixture allocation failed: ${payload.error || 'unknown'}`); lease = payload;
  assertions.realRegistrationAndLogin = 'PASS';
  const api = (path, session, body) => fetch(`${config.authOrigin}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json', connection: 'close' }, body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const [a, b, c] = lease.accounts;
  const identity = { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, sourceSha: process.env.GITHUB_SHA };
  await assert.rejects(factory.cleanup({ ...identity, runId: `${identity.runId}1` }, lease.leaseId), /lease_forbidden/);
  assertions.crossRunCleanupDenied = 'PASS';
  const aUsers = await Promise.all(a.sessions.map(async s => { const r = await api('/api/auth/user-info', s); assert.equal(r.status, 200); return r.json(); }));
  assert.ok((aUsers[0].user?.id ?? aUsers[0].id) != null && (aUsers[1].user?.id ?? aUsers[1].id) != null);
  assert.equal(String(aUsers[0].user?.id ?? aUsers[0].id), String(aUsers[1].user?.id ?? aUsers[1].id));
  const bResponse = await api('/api/auth/user-info', b.sessions[0]); assert.equal(bResponse.status, 200);
  const bUser = await bResponse.json();
  assert.equal(String(bUser.user?.id ?? bUser.id), String(b.sessions[0].user.id));
  assert.notEqual(String(aUsers[0].user?.id ?? aUsers[0].id), String(bUser.user?.id ?? bUser.id));
  assertions.sameAccountMultiSession = 'PASS';
  const spoofed = await api(`/api/auth/user-info?userId=${encodeURIComponent(String(b.sessions[0].user.id))}`, a.sessions[0]);
  assert.equal(spoofed.status, 200);
  const spoofedUser = await spoofed.json();
  assert.equal(String(spoofedUser.user?.id ?? spoofedUser.id), String(a.sessions[0].user.id));
  assertions.crossAccountIdentitySpoofDenied = 'PASS';
  const identities = sql('SELECT algo, password_hash FROM users'); assert.equal(identities.length, 3); assert.ok(identities.every(u => u.algo === 'argon2id' && u.password_hash === ''));
  const passwords = sql('SELECT password_phc FROM account_password_credentials'); assert.ok(passwords.every(u => u.password_phc.startsWith('$argon2id$')));
  assertions.canonicalArgon2id = 'PASS';
  const header = JSON.parse(Buffer.from(a.sessions[0].accessToken.split('.')[0], 'base64url')); assert.equal(header.alg, 'RS256'); assertions.canonicalRS256 = 'PASS';
  const wrongPassword = await fetch(`${config.authOrigin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: b.username, password: a.password, deviceId: a.deviceIds[0] }), redirect: 'error' }); assert.equal(wrongPassword.status, 401); assertions.crossAccountPasswordDenied = 'PASS';
  const rotatedResponse = await api('/api/auth/refresh', c.sessions[0], { refreshToken: c.sessions[0].refreshToken }); assert.equal(rotatedResponse.status, 200);
  const rotated = await rotatedResponse.json(); assert.ok(rotated.refreshToken !== c.sessions[0].refreshToken); assertions.refreshRotation = 'PASS';
  const logout = await api('/api/auth/logout', rotated, {}); assert.equal(logout.status, 200);
  const afterLogout = await api('/api/auth/user-info', rotated); assert.equal(afterLogout.status, 401);
  const revokedRefresh = await api('/api/auth/refresh', rotated, { refreshToken: rotated.refreshToken }); assert.equal(revokedRefresh.status, 401); assertions.sessionRevocation = 'PASS';
  assert.equal((await api('/api/auth/user-info', a.sessions[1])).status, 200); assertions.otherSessionRetained = 'PASS';
  assert.ok(typeof b.sessions[0].sessionId === 'string');
  sql(`UPDATE account_sessions SET expires_at=0 WHERE session_id=${escape(b.sessions[0].sessionId)} AND user_id=${escape(String(b.sessions[0].user.id))};`);
  assert.equal((await api('/api/auth/user-info', b.sessions[0])).status, 401); assertions.expiredSessionDenied = 'PASS';
  const cleanup = await fixtureRequest(`/v1/leases/${lease.leaseId}`, 'DELETE'); assert.equal(cleanup.status, 200); assert.equal((await cleanup.json()).remaining, 0); assertions.zeroResidualCleanup = 'PASS';
  const stale = await api('/api/auth/user-info', a.sessions[0]); assert.equal(stale.status, 401); assertions.deletedSessionDenied = 'PASS';
  const ttlResponse = await fixtureRequest('/v1/leases', 'POST', { scenarioId: 'actual-ttl' });
  const ttlLease = await ttlResponse.json(); assert.equal(ttlResponse.status, 201);
  factoryTime = ttlLease.expiresAt + 1;
  const swept = await factory.sweep(); assert.ok(swept.some(r => r.leaseId === ttlLease.leaseId && r.remaining === 0));
  assert.equal((await api('/api/auth/user-info', ttlLease.accounts[0].sessions[0])).status, 401);
  assertions.ttlReclamation = 'PASS'; evidence.ttlClock = 'factory-controlled; Core authentication uses real clock';
  evidence.wasmSha256 = createHash('sha256').update(readFileSync(resolve('core/deploy/platform-worker/build/worker/index.wasm'))).digest('hex');
  evidence.testCount = Object.keys(assertions).length; evidence.overall = 'PASS';
} finally {
  if (factory && journal) {
    for (const id of journal.db.prepare("SELECT id FROM leases WHERE state!='cleaned'").all()) {
      try { await factory.clean(id.id); } catch { evidence.cleanup = 'blocked'; evidence.overall = 'FAIL'; }
    }
    journal.close();
  }
  writeFileSync('evidence/runtime.json', JSON.stringify(evidence, null, 2));
  worker?.kill('SIGTERM');
  await Promise.all(servers.map(server => new Promise(done => server.close(done))));
}
console.log(`Actual canonical Worker runtime: ${evidence.testCount} assertions, ${evidence.overall}; cloud/package acceptance NOT_VERIFIED.`);
