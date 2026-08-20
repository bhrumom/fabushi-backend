import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function withBackend(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-egress-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tempDir,
      SQLITE_PATH: path.join(tempDir, 'backend.sqlite'),
      TEST_ACCOUNT_TOKEN: 'egress-test-token',
      RATE_LIMIT_PER_MINUTE: '10000',
      LOG_LEVEL: 'fatal',
      ENABLE_CODEX_SDK: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`backend exited early with code ${child.exitCode}`);
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) break;
      } catch {
        // Retry.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await run(baseUrl);
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

const headers = () => ({
  authorization: 'Bearer egress-test-token',
  'content-type': 'application/json',
  'user-agent': 'fabushi-egress-test',
});

async function requestJson(baseUrl, route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, init);
  return { response, payload: await response.json() };
}

test('managed egress status is explicit and SSRF targets are rejected', async () => {
  await withBackend(async (baseUrl) => {
    let result = await requestJson(baseUrl, '/api/egress/status', { headers: headers() });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.egress.available, true);
    assert.equal(result.payload.egress.transport, 'https-relay');
    assert.equal(result.payload.egress.agentEnabled, false);

    for (const url of [
      'http://example.com/',
      'https://127.0.0.1/',
      'https://localhost/',
      'https://user:password@example.com/',
      'https://example.com:8443/',
    ]) {
      result = await requestJson(baseUrl, '/api/egress/fetch', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ url, method: 'GET' }),
      });
      assert.ok(result.response.status >= 400 && result.response.status < 500, `${url} should be rejected`);
      assert.equal(result.payload.success, false);
    }
  });
});
