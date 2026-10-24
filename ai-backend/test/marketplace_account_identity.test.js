import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { resolveMarketplaceAccountIdentity as resolve } from '../src/marketplace_account_identity.js';

const request = (token = 'isolated-session-a') => ({ headers: { authorization: `Bearer ${token}`, 'x-fabushi-device-id': 'isolated-device' } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const options = (fetchImpl, extra = {}) => ({ requireAuthenticated: true, apiBaseUrl: 'https://api.ombhrum.com', fetchImpl, ...extra });
const denied = (code, status) => (error) => {
  assert.equal(error.code, code); assert.equal(error.statusCode, status);
  assert.doesNotMatch(error.message, /isolated-session|private-profile/);
  return true;
};

test('native immutable account identity survives session and display-name changes without caching revocation', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 3 ? json({}, 401) : json({ data: { user: { id: 42, username: `name-${calls.length}`, email: 'display@example.invalid' } } });
  };
  const first = await resolve(request(), options(fetchImpl));
  const second = await resolve(request('isolated-session-b'), options(fetchImpl));
  assert.equal(first.accountId, 'user:42');
  assert.equal(first.scopeId, second.scopeId);
  assert.equal(first.publisherId, second.publisherId);
  assert.notEqual(first.username, second.username);
  await assert.rejects(resolve(request(), options(fetchImpl)), denied('ACCOUNT_AUTH_REQUIRED', 401));
  assert.equal(calls.length, 3);
  for (const { url, init } of calls) {
    assert.equal(url, 'https://api.ombhrum.com/api/auth/user-info');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls[1].init.headers.Authorization, 'Bearer isolated-session-b');
});

test('display aliases and malformed IDs never satisfy private account authentication', async () => {
  for (const payload of [
    { username: 'private-profile' }, { email: 'display@example.invalid' },
    { id: {} }, { id: ['42'] }, { id: true }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 },
    { id: 'bad/path' }, { id: 'a'.repeat(201) }, { data: { user: { id: null, username: 'private-profile' } } },
  ]) await assert.rejects(resolve(request(), options(async () => json(payload))), denied('ACCOUNT_AUTH_REQUIRED', 401));
  const valid = await resolve(request(), options(async () => json({ data: { user_id: 'native-account_123' } })));
  assert.equal(valid.accountId, 'user:native-account_123');
  await assert.rejects(resolve({ headers: { 'x-fabushi-device-id': 'device-only' } }, options(async () => { throw new Error('must not fetch'); })), denied('ACCOUNT_AUTH_REQUIRED', 401));
});

test('unapproved origins are rejected before exposing a bearer to fetch', async () => {
  for (const apiBaseUrl of [
    'https://foreign.example', 'http://api.ombhrum.com', 'https://api.ombhrum.com:444',
    'https://api.ombhrum.com/other', 'https://api.ombhrum.com/?x=1', 'https://api.ombhrum.com/#fragment',
    'https://user:password@api.ombhrum.com', 'https://api.ombhrum.com.foreign.example', 'not-a-url',
  ]) {
    let calls = 0;
    await assert.rejects(resolve(request(), options(async () => { calls += 1; return json({ id: 42 }); }, { apiBaseUrl })), denied('ACCOUNT_AUTH_UNAVAILABLE', 503));
    assert.equal(calls, 0);
  }
  for (const apiBaseUrl of ['https://fabushi-ci-isolated-auth.bhrumom.workers.dev', 'http://127.0.0.1:43210', 'https://localhost:43210', 'http://[::1]:43210']) {
    let observed;
    await resolve(request(), options(async (url) => { observed = url; return json({ id: 42 }); }, { apiBaseUrl }));
    assert.equal(observed, `${apiBaseUrl}/api/auth/user-info`);
  }
});

test('profile body bounds, invalid JSON, authority failures and private errors fail closed', async () => {
  const responses = [
    () => new Response('private-profile', { headers: { 'content-length': String(65537) } }),
    () => new Response(' '.repeat(65537)),
    () => new Response('private-profile'),
    () => new Response(new Uint8Array([255])),
    () => json({}, 500),
  ];
  for (const response of responses) await assert.rejects(resolve(request(), options(async () => response())), denied('ACCOUNT_AUTH_UNAVAILABLE', 503));
  await assert.rejects(resolve(request(), options(async () => json({}, 403))), denied('ACCOUNT_AUTH_REQUIRED', 403));
  await assert.rejects(resolve(request(), options(async () => { throw new Error('private-profile isolated-session'); })), denied('ACCOUNT_AUTH_UNAVAILABLE', 503));
});

test('real native HTTP client refuses redirect without visiting its destination', async () => {
  let destinationCalls = 0;
  const destination = http.createServer((_req, res) => { destinationCalls += 1; res.end('{"id":42}'); });
  const origin = http.createServer((req, res) => {
    assert.equal(req.url, '/api/auth/user-info');
    res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/capture` }); res.end();
  });
  const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', done));
  const close = (server) => new Promise((done) => { server.close(done); server.closeAllConnections(); });
  await listen(destination); await listen(origin);
  try {
    await assert.rejects(resolve(request(), options(globalThis.fetch, { apiBaseUrl: `http://127.0.0.1:${origin.address().port}` })), denied('ACCOUNT_AUTH_UNAVAILABLE', 503));
    assert.equal(destinationCalls, 0);
  } finally { await close(origin); await close(destination); }
});

test('trusted local resolver and public local scope preserve their explicit contracts', async () => {
  const trusted = await resolve(request(), options(async () => { throw new Error('must not fetch'); }, { resolveUser: async () => ({ userId: 'local-account', isAuthenticated: true }) }));
  assert.equal(trusted.accountId, 'user:local-account');
  const publicScope = await resolve(request(), options(async () => json({ username: 'private-profile' }), { requireAuthenticated: false }));
  assert.equal(publicScope.authenticated, false);
  assert.equal(publicScope.localOnly, true);
  assert.equal(publicScope.accountId, null);
});
