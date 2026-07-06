import test from 'node:test';
import assert from 'node:assert/strict';

import { handleDachengAiProxy, isDachengAiPath } from '../src/handlers/dacheng-ai.js';

test('Dacheng AI proxy includes first-party agent endpoints', () => {
  assert.equal(isDachengAiPath('/api/agent/chat'), true);
  assert.equal(isDachengAiPath('/api/agent/runs/run_1/events'), true);
  assert.equal(isDachengAiPath('/api/agent/runs/run_1/cancel'), true);
  assert.equal(isDachengAiPath('/api/agent/messages/msg_1/feedback'), true);
});

test('Dacheng AI proxy includes OpenClaw DeepSeek fallback endpoints', () => {
  assert.equal(isDachengAiPath('/api/openclaw/deepseek/v1/chat/completions'), true);
  assert.equal(isDachengAiPath('/api/openclaw/runtime/manifest'), true);
});

test('Dacheng AI proxy includes Bot Father and MiniApp registry endpoints', () => {
  assert.equal(isDachengAiPath('/api/botfather/generate-miniapp'), true);
  assert.equal(isDachengAiPath('/api/miniapps/registry'), true);
  assert.equal(isDachengAiPath('/api/miniapps/dev/create'), true);
  assert.equal(isDachengAiPath('/api/miniapps/dev/test_app/index.html'), true);
});

test('Dacheng AI proxy still rejects unrelated API endpoints', () => {
  assert.equal(isDachengAiPath('/api/auth/login'), false);
});

test('Dacheng AI proxy forwards OpenClaw DeepSeek fallback requests', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.equal(
      url.toString(),
      'https://ai.example.test/api/openclaw/deepseek/v1/chat/completions?source=desktop',
    );
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.get('X-Forwarded-Host'), 'api.ombhrum.com');
    assert.equal(init.headers.get('X-Forwarded-Proto'), 'https');
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };

  const response = await handleDachengAiProxy(
    new Request(
      'https://api.ombhrum.com/api/openclaw/deepseek/v1/chat/completions?source=desktop',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
      },
    ),
    { DACHENG_AI_BACKEND_URL: 'https://ai.example.test' },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
});

test('Dacheng AI proxy converts Cloudflare tunnel HTML into JSON error', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    assert.equal(url.toString(), 'https://ai.example.test/api/ai/chat/stream');
    return new Response(
      '<!doctype html><title>Cloudflare Tunnel error</title><div id="cf-error-details">error code: 1033</div>',
      {
        status: 530,
        statusText: 'Origin DNS Error',
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      },
    );
  };

  const response = await handleDachengAiProxy(
    new Request('https://api.ombhrum.com/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    }),
    { DACHENG_AI_BACKEND_URL: 'https://ai.example.test' },
  );

  assert.equal(response.status, 502);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);

  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.message, '大乘 AI 后端暂时不可用，请稍后重试。');
  assert.equal(body.upstreamStatus, 530);
});

test('Dacheng AI proxy preserves SSE content type on successful streams', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response('event: done\ndata: {"message":"阿弥陀佛"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });

  const response = await handleDachengAiProxy(
    new Request('https://api.ombhrum.com/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    }),
    { DACHENG_AI_BACKEND_URL: 'https://ai.example.test' },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
});
