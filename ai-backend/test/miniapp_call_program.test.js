import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMiniAppManifest } from '../src/miniapp_marketplace.js';

function manifest(overrides = {}) {
  return {
    id: 'call-program-fixture',
    version: '1.0.0',
    title: 'Call Program Fixture',
    description: 'Fixture for Mini App Bot call-program normalization.',
    publisher: { id: 'fabushi', displayName: 'Fabushi', verified: true },
    surfaces: [
      { id: 'ui', kind: 'web', entry: 'index.html', platforms: ['desktop'] },
      { id: 'mcp', kind: 'mcp-http', url: 'https://example.com/mcp', platforms: ['desktop'] },
    ],
    commands: [
      { name: 'balance', description: 'Query balance', surfaceId: 'mcp', tool: 'balance', approval: 'none' },
    ],
    bot: {
      id: 'call-program-bot',
      username: 'call_program_bot',
      displayName: 'Call Program Bot',
      calls: {
        voice: {
          type: 'service-call',
          title: '客服电话',
          aiMode: 'optional',
          startState: 'root',
          states: [
            {
              id: 'root',
              prompt: '查询余额请按 1，退出请按 0。',
              routes: [
                { digits: '1', action: 'command', command: 'balance', arguments: { scope: 'account' }, nextState: 'root' },
                { digits: '0', action: 'end' },
              ],
            },
          ],
        },
        video: {
          type: 'miniapp-surface',
          title: '自定义视频服务',
          surfaceId: 'ui',
          aiMode: 'disabled',
        },
      },
    },
    permissions: ['microphone', 'camera'],
    review: { state: 'approved' },
    ...overrides,
  };
}

test('MiniApp manifest preserves validated Bot voice/video call programs', () => {
  const normalized = normalizeMiniAppManifest(manifest());
  assert.equal(normalized.bot.calls.voice.type, 'service-call');
  assert.equal(normalized.bot.calls.voice.startState, 'root');
  assert.equal(normalized.bot.calls.voice.states[0].routes[0].command, 'balance');
  assert.deepEqual(normalized.bot.calls.voice.states[0].routes[0].arguments, { scope: 'account' });
  assert.equal(normalized.bot.calls.video.type, 'miniapp-surface');
  assert.equal(normalized.bot.calls.video.surfaceId, 'ui');
  assert.equal(normalized.bot.calls.video.aiMode, 'disabled');
});

test('MiniApp call-program rejects unknown call UI surface', () => {
  const value = manifest();
  value.bot.calls.video.surfaceId = 'missing-ui';
  assert.throws(() => normalizeMiniAppManifest(value), /unknown surface missing-ui/);
});

test('MiniApp service-call rejects unknown state transitions', () => {
  const value = manifest();
  value.bot.calls.voice.states[0].routes[0].nextState = 'missing-state';
  assert.throws(() => normalizeMiniAppManifest(value), /unknown next state missing-state/);
});

test('MiniApp service-call command route must target a declared MiniApp command', () => {
  const value = manifest();
  value.bot.calls.voice.states[0].routes[0].command = 'host-secret-command';
  assert.throws(() => normalizeMiniAppManifest(value), /unknown command host-secret-command/);
});

test('MiniApp fixed IVR does not require AI', () => {
  const value = manifest();
  value.bot.calls.voice.aiMode = 'disabled';
  const normalized = normalizeMiniAppManifest(value);
  assert.equal(normalized.bot.calls.voice.aiMode, 'disabled');
  assert.equal(normalized.bot.calls.voice.states[0].routes[1].action, 'end');
});
