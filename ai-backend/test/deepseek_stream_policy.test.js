import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactDeepSeekMessagesForFirstTokenRetry,
  deepSeekFirstTokenTimeoutMs,
  deepSeekStreamTimeoutMs,
  firstTokenTimeoutError,
  isFirstTokenTimeout,
} from '../src/deepseek_stream_policy.js';

test('first-token timeout is bounded well below the overall stream timeout', () => {
  const env = {
    DEEPSEEK_FIRST_TOKEN_TIMEOUT_MS: '12000',
    DEEPSEEK_STREAM_TIMEOUT_MS: '90000',
  };
  assert.equal(deepSeekFirstTokenTimeoutMs(env), 12000);
  assert.equal(deepSeekStreamTimeoutMs(env), 90000);
  const error = firstTokenTimeoutError(12000);
  assert.equal(error.code, 'DEEPSEEK_FIRST_TOKEN_TIMEOUT');
  assert.equal(error.retryable, true);
  assert.equal(isFirstTokenTimeout(error), true);
});

test('first-token retry projection keeps system identity and recent turn tail', () => {
  const messages = [
    { role: 'system', content: 'You are Mahayana.' },
    ...Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `old-${index}-${'x'.repeat(20_000)}`,
    })),
    { role: 'user', content: '你好' },
  ];
  const compacted = compactDeepSeekMessagesForFirstTokenRetry(messages, {
    maxMessages: 6,
    maxCharsPerMessage: 1000,
  });
  assert.equal(compacted[0].role, 'system');
  assert.equal(compacted.at(-1).content, '你好');
  assert.equal(compacted.length, 7);
  assert.ok(compacted.every((message) => String(message.content ?? '').length < 1200));
});

test('retry projection preserves recent tool-call adjacency', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'read plugin' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"plugin.json"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"name":"demo"}' },
  ];
  const compacted = compactDeepSeekMessagesForFirstTokenRetry(messages, { maxMessages: 4 });
  assert.equal(compacted.at(-2).tool_calls[0].id, 'call_1');
  assert.equal(compacted.at(-1).tool_call_id, 'call_1');
});
