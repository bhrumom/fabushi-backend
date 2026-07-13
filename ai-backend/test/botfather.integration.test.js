import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(testDir, '..');

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHealth(origin, child, logs) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`backend exited before health check:\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`backend health check timed out:\n${logs.join('')}`);
}

test('Bot Father reports Codex unavailability instead of claiming template success', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fabushi-botfather-test-'));
  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      SQLITE_PATH: path.join(dataDir, 'test.sqlite'),
      FABUSHI_API_BASE_URL: 'http://127.0.0.1:1',
      DEEPSEEK_API_KEY: '',
      ENABLE_CODEX_SDK_CHAT: 'false',
      ENABLE_OPENCLAW_AGENT_CHAT: 'false',
      ENABLE_LIBRECHAT_AGENT_CHAT: 'false',
      TEST_ACCOUNT_TOKEN: 'botfather-integration-token',
      LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  t.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(origin, child, logs);

  const prompt = '创建一个可以记录每日念佛数量的小程序';
  const response = await fetch(`${origin}/api/botfather/generate-miniapp`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer botfather-integration-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt }),
  });
  assert.equal(response.status, 503);

  const payload = await response.json();
  assert.equal(payload.success, false);
  assert.match(payload.message, /Codex|provider|unavailable/i);

  await assert.rejects(
    readFile(path.join(dataDir, 'miniapps', 'sandbox-miniapps.json'), 'utf8'),
    (error) => error?.code === 'ENOENT',
  );
});
