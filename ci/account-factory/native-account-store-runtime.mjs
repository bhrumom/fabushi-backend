// Actual existing Node data service, authenticated through canonical Core HTTP.
// All accounts/tokens are supplied by the ordinary isolated account factory.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AccountSyncStore } from '../../ai-backend/src/account_sync_store.js';
import { createMiniAppMarketplaceRouter } from '../../ai-backend/src/miniapp_marketplace_http.js';
import { createNativeAccountJsonParser, MAX_AGENT_OBJECT_BYTES } from '../../ai-backend/src/native_account_json.js';

const requireBackend = createRequire(new URL('../../ai-backend/package.json', import.meta.url));
const Database = requireBackend('better-sqlite3');
const express = requireBackend('express');

export async function startNativeAccountStoreRuntime({ authOrigin, root }) {
  if (process.env.GITHUB_ACTIONS !== 'true' || authOrigin !== 'https://127.0.0.1:9443' || process.env.TEST_ACCOUNT_TOKEN) throw Error('native_file_isolation_required');
  const previousOrigin = process.env.FABUSHI_API_BASE_URL;
  process.env.FABUSHI_API_BASE_URL = authOrigin;
  mkdirSync(root, { mode: 0o700 });
  const db = new Database(join(root, 'account.sqlite'));
  db.pragma('journal_mode = WAL');
  const app = express();
  app.use(createNativeAccountJsonParser());
  // Deliberately no resolveUser/fetch identity injection: the actual resolver
  // calls the live local Core account authority on every private request.
  app.use(createMiniAppMarketplaceRouter({ dataDir: root, storagePath: join(root, 'marketplace.json'), accountSyncStore: new AccountSyncStore({ db }) }).router);
  app.use((error, _req, res, _next) => res.status(Number(error?.statusCode) || 500).json({ error: { code: error?.code || 'internal_error' } }));
  const server = await new Promise((done, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => done(listening));
    listening.once('error', reject);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/account/agents/issued-native-files/store`;
  async function call(session, method, path, body) {
    return fetch(`${endpoint}?path=${encodeURIComponent(path)}`, { method, redirect: 'error',
      headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify({ path, ...body }), signal: AbortSignal.timeout(20000) });
  }
  async function ok(response, status = 200) {
    assert.equal(response.status, status, 'native file response status');
    return response.json();
  }
  let closed = false;
  return {
    async verifyIssuedAccounts(a, b, cSession, assertions) {
      await ok(await call(a.sessions[0], 'PUT', 'empty.bin', { dataBase64: '', expectAbsent: true }));
      assert.equal((await ok(await call(a.sessions[1], 'GET', 'empty.bin'))).dataBase64, '');
      const bytes = Buffer.alloc(MAX_AGENT_OBJECT_BYTES, 173);
      const stored = await ok(await call(a.sessions[0], 'PUT', 'max.bin', { dataBase64: bytes.toString('base64'), expectAbsent: true }));
      assert.deepEqual(Buffer.from((await ok(await call(a.sessions[1], 'GET', 'max.bin'))).dataBase64, 'base64'), bytes);
      assertions.nativeFileIssuedSessionConvergence = 'PASS';
      assert.equal((await call(b.sessions[0], 'GET', 'max.bin')).status, 404);
      await ok(await call(b.sessions[0], 'PUT', 'max.bin', { dataBase64: 'Yg==', expectAbsent: true }));
      assert.equal((await ok(await call(a.sessions[1], 'GET', 'max.bin'))).etag, stored.etag);
      assertions.nativeFileAccountIsolation = 'PASS';
      const conflict = await ok(await call(a.sessions[1], 'PUT', 'max.bin', { dataBase64: 'bG9zZXI=', baseEtag: 'stale-etag' }), 409);
      assert.equal((await ok(await call(a.sessions[0], 'GET', conflict.conflictPath))).dataBase64, 'bG9zZXI=');
      assert.equal((await ok(await call(a.sessions[0], 'GET', 'max.bin'))).etag, stored.etag);
      assertions.nativeFileConflictPreserved = 'PASS';
      await ok(await call(cSession, 'PUT', 'max.bin', { dataBase64: 'Yw==', expectAbsent: true }));
    },
    async verifyDenied(session, assertion, assertions) {
      assert.equal((await call(session, 'GET', 'max.bin')).status, 401);
      assert.equal((await call(session, 'PUT', 'denied.bin', { dataBase64: 'eA==', expectAbsent: true })).status, 401);
      assertions[assertion] = 'PASS';
    },
    async close() {
      if (closed) return;
      await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); });
      db.close();
      rmSync(root, { recursive: true, force: false });
      assert.equal(existsSync(root), false, 'owned native file fixture must leave zero residuals');
      if (previousOrigin === undefined) delete process.env.FABUSHI_API_BASE_URL;
      else process.env.FABUSHI_API_BASE_URL = previousOrigin;
      closed = true;
    },
  };
}
