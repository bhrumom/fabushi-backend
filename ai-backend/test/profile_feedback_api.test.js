import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import Database from 'better-sqlite3';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`backend exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Retry until deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('backend health check timed out');
}

async function withBackend(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-profile-'));
  const sqlitePath = path.join(tempDir, 'backend.sqlite');
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tempDir,
      SQLITE_PATH: sqlitePath,
      TEST_ACCOUNT_TOKEN: 'profile-owner-token',
      RATE_LIMIT_PER_MINUTE: '10000',
      LOG_LEVEL: 'fatal',
      ENABLE_CODEX_SDK: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child);
    await run({ baseUrl, sqlitePath });
  } catch (error) {
    error.message = `${error.message}\nbackend stderr:\n${stderr.slice(-4000)}`;
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const ownerHeaders = () => ({
  authorization: 'Bearer profile-owner-token',
  'content-type': 'application/json',
  'user-agent': 'fabushi-profile-owner-test',
});

const guestHeaders = () => ({
  'content-type': 'application/json',
  'user-agent': 'fabushi-profile-guest-test',
});

async function requestJson(baseUrl, route, { method = 'GET', headers, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test('profile and feedback APIs are user scoped and validate avatar payloads', async () => {
  await withBackend(async ({ baseUrl, sqlitePath }) => {
    const avatarBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fabushi-test-avatar'),
    ]);
    const avatar = `data:image/png;base64,${avatarBytes.toString('base64')}`;
    let result = await requestJson(baseUrl, '/api/account/profile', {
      method: 'PATCH',
      headers: ownerHeaders(),
      body: { displayName: '  Release   Owner  ', avatarDataUrl: avatar },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.profile.displayName, 'Release Owner');
    assert.equal(result.payload.profile.avatarDataUrl, avatar);

    result = await requestJson(baseUrl, '/api/account/profile', { headers: guestHeaders() });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.profile.displayName, null);
    assert.equal(result.payload.profile.avatarDataUrl, null);

    result = await requestJson(baseUrl, '/api/account/profile', {
      method: 'PATCH',
      headers: guestHeaders(),
      body: { displayName: 'Guest User' },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.profile.displayName, 'Guest User');

    result = await requestJson(baseUrl, '/api/account/profile', { headers: ownerHeaders() });
    assert.equal(result.payload.profile.displayName, 'Release Owner');
    assert.equal(result.payload.profile.avatarDataUrl, avatar);

    result = await requestJson(baseUrl, '/api/account/profile', {
      method: 'PATCH',
      headers: ownerHeaders(),
      body: { avatarDataUrl: 'data:text/plain;base64,Zm9v' },
    });
    assert.equal(result.response.status, 400);

    result = await requestJson(baseUrl, '/api/feedback', {
      method: 'POST',
      headers: ownerHeaders(),
      body: { category: 'product', message: 'Cloud run panel is useful.', context: { surface: 'cloud-run' } },
    });
    assert.equal(result.response.status, 201);
    const ownerFeedbackId = result.payload.feedback.id;

    result = await requestJson(baseUrl, '/api/feedback', {
      method: 'POST',
      headers: guestHeaders(),
      body: { category: 'usability', message: 'Guest feedback', context: { surface: 'settings' } },
    });
    assert.equal(result.response.status, 201);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const rows = db.prepare('SELECT id, user_id AS userId, message, context_json AS contextJson FROM product_feedback ORDER BY created_at').all();
      assert.equal(rows.length, 2);
      assert.equal(rows[0].id, ownerFeedbackId);
      assert.notEqual(rows[0].userId, rows[1].userId);
      assert.equal(JSON.parse(rows[0].contextJson).surface, 'cloud-run');
    } finally {
      db.close();
    }
  });
});
