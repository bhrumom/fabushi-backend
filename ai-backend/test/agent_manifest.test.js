import test from 'node:test';
import assert from 'node:assert/strict';

import { validateAgentManifest } from '../src/agent_manifest.js';

const validManifest = {
  schemaVersion: 1,
  agentId: 'com.example.cleaner',
  name: 'Cleaner',
  version: '1.0.0',
  developerId: 'dev_123',
  entry: {
    mode: 'node',
    command: 'node',
    args: ['main.js'],
    workingDirectory: '.',
    transport: 'stdio',
    runInShell: false,
  },
  package: {
    type: 'zip',
    url: 'https://example.com/agent.zip',
    sha256: 'a'.repeat(64),
    signature: 'sig_dev_123',
  },
  companionMiniApp: {
    entryUrl: 'https://example.com/fabushi/setup',
    origin: 'https://example.com',
  },
  secrets: [
    { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', storage: 'device_keychain', injectAs: 'env' },
  ],
  permissions: [
    {
      name: 'files.userSelected.readWrite',
      scope: 'selected_directory',
      riskLevel: 'high',
      confirmationPolicy: 'per_task',
      reason: '整理用户选择的目录',
    },
  ],
  commands: [{ command: '/status', description: '查看状态' }],
  pricing: { model: 'free' },
};

test('validates a production-shaped manifest', () => {
  const result = validateAgentManifest(validManifest, { verifiedOrigins: ['https://example.com'] });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.match(result.manifestHash, /^[a-f0-9]{64}$/);
});

test('blocks shell execution and plaintext secrets', () => {
  const result = validateAgentManifest({
    ...validManifest,
    entry: { mode: 'cli', command: 'sh', transport: 'stdio', runInShell: true },
    secrets: [{ key: 'OPENAI_API_KEY', storage: 'device_keychain', injectAs: 'env', value: 'secret' }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === 'blocked_command'));
  assert.ok(result.errors.some((issue) => issue.code === 'run_in_shell_forbidden'));
  assert.ok(result.errors.some((issue) => issue.code === 'secret_plaintext_forbidden'));
});

test('requires FUDE_JIN and refund policy for paid run pricing', () => {
  const result = validateAgentManifest({
    ...validManifest,
    pricing: { model: 'pay_per_run', amount: 10, currency: 'USD' },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === 'unsupported_currency'));
  assert.ok(result.errors.some((issue) => issue.code === 'refund_policy_required'));
});
