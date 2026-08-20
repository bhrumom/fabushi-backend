import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`backend exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('backend health check timed out');
}

async function withBackend(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-collaboration-'));
  const sqlitePath = path.join(tempDir, 'backend.sqlite');
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tempDir,
      SQLITE_PATH: sqlitePath,
      TEST_ACCOUNT_TOKEN: 'owner-test-token',
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

function ownerHeaders() {
  return {
    authorization: 'Bearer owner-test-token',
    'content-type': 'application/json',
    'user-agent': 'fabushi-collaboration-owner-test',
  };
}

function guestHeaders() {
  return {
    'content-type': 'application/json',
    'user-agent': 'fabushi-collaboration-guest-test',
  };
}

async function jsonRequest(baseUrl, route, { method = 'GET', headers, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

test('shared rooms enforce user isolation, hashed invites, owner approval and own-agent mutation', async () => {
  await withBackend(async ({ baseUrl, sqlitePath }) => {
    let result = await jsonRequest(baseUrl, '/api/collaboration/rooms', {
      method: 'POST',
      headers: ownerHeaders(),
      body: { name: 'Release room', ownerAgentId: 'owner-agent', memberAgentIds: ['owner-agent'] },
    });
    assert.equal(result.response.status, 201);
    const roomId = result.payload.room.id;
    assert.equal(result.payload.room.scope, 'fabushi-platform');
    assert.deepEqual(result.payload.room.ownAgentIds, ['owner-agent']);

    result = await jsonRequest(baseUrl, '/api/collaboration/state', { headers: guestHeaders() });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.state.rooms, []);

    result = await jsonRequest(baseUrl, `/api/collaboration/rooms/${encodeURIComponent(roomId)}/invites`, {
      method: 'POST', headers: ownerHeaders(), body: {},
    });
    assert.equal(result.response.status, 201);
    const inviteToken = result.payload.invite.token;
    assert.match(inviteToken, /^fabushi_[A-Za-z0-9_-]+$/);
    const db = new Database(sqlitePath, { readonly: true });
    try {
      const inviteRow = db.prepare('SELECT token_hash FROM collaboration_invites LIMIT 1').get();
      assert.notEqual(inviteRow.token_hash, inviteToken);
      assert.equal(inviteRow.token_hash, crypto.createHash('sha256').update(inviteToken).digest('hex'));
    } finally {
      db.close();
    }

    result = await jsonRequest(baseUrl, `/api/collaboration/invites/${encodeURIComponent(inviteToken)}/join`, {
      method: 'POST', headers: guestHeaders(), body: { agentId: 'guest-agent', displayName: 'Guest Agent' },
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.payload.request.status, 'pending');
    const requestId = result.payload.request.id;

    result = await jsonRequest(baseUrl, `/api/collaboration/join-requests/${encodeURIComponent(requestId)}/respond`, {
      method: 'POST', headers: guestHeaders(), body: { accept: true },
    });
    assert.equal(result.response.status, 403);

    result = await jsonRequest(baseUrl, `/api/collaboration/join-requests/${encodeURIComponent(requestId)}/respond`, {
      method: 'POST', headers: ownerHeaders(), body: { accept: true },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.request.status, 'accepted');

    result = await jsonRequest(baseUrl, '/api/collaboration/state', { headers: guestHeaders() });
    assert.equal(result.payload.state.rooms.length, 1);
    assert.deepEqual(result.payload.state.rooms[0].ownAgentIds, ['guest-agent']);

    result = await jsonRequest(baseUrl, `/api/collaboration/rooms/${encodeURIComponent(roomId)}/members`, {
      method: 'POST', headers: guestHeaders(), body: { agentId: 'guest-agent-2' },
    });
    assert.equal(result.response.status, 200);

    result = await jsonRequest(baseUrl, `/api/collaboration/rooms/${encodeURIComponent(roomId)}/members/guest-agent`, {
      method: 'DELETE', headers: ownerHeaders(),
    });
    assert.equal(result.response.status, 200);
    assert.ok(result.payload.room.memberAgentIds.includes('guest-agent'));

    result = await jsonRequest(baseUrl, `/api/collaboration/rooms/${encodeURIComponent(roomId)}/members/guest-agent`, {
      method: 'DELETE', headers: guestHeaders(),
    });
    assert.equal(result.response.status, 200);
    assert.ok(!result.payload.room.ownAgentIds.includes('guest-agent'));
    assert.ok(result.payload.room.ownAgentIds.includes('guest-agent-2'));

    result = await jsonRequest(baseUrl, `/api/collaboration/rooms/${encodeURIComponent(roomId)}/leave`, {
      method: 'POST', headers: guestHeaders(), body: { agentId: 'guest-agent-2' },
    });
    assert.equal(result.response.status, 200);

    result = await jsonRequest(baseUrl, '/api/collaboration/state', { headers: guestHeaders() });
    assert.deepEqual(result.payload.state.rooms, []);

    result = await jsonRequest(baseUrl, '/api/collaboration/state', { headers: ownerHeaders() });
    assert.equal(result.payload.state.rooms.length, 1);
    assert.ok(result.payload.state.rooms[0].memberAgentIds.includes('owner-agent'));
  });
});
