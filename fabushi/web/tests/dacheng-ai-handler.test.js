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
  assert.equal(isDachengAiPath('/codex-deepseek/v1/responses'), true);
});

test('Dacheng AI proxy includes plugin registry and MCP endpoints', () => {
  assert.equal(isDachengAiPath('/api/plugins/registry'), true);
  assert.equal(isDachengAiPath('/api/mcp/apps/global-dharma'), true);
  assert.equal(isDachengAiPath('/api/codex/apps/global-dharma/turns'), true);
  assert.equal(isDachengAiPath('/api/miniapps/registry'), false);
  assert.equal(isDachengAiPath('/api/botfather/generate-miniapp'), false);
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

test('Dacheng AI proxy routes only the configured test account to the Responses adapter', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const testToken = 'test-account-token-with-at-least-thirty-two-characters';

  globalThis.fetch = async (url, init) => {
    assert.equal(url.toString(), 'https://responses.example.test/v1/ai/responses');
    assert.equal(init.headers.get('Authorization'), `Bearer ${testToken}`);
    return new Response('event: response.completed\ndata: {}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };

  const response = await handleDachengAiProxy(
    new Request('https://api.ombhrum.com/v1/ai/responses', {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${testToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: 'test', stream: true }),
    }),
    {
      DACHENG_AI_BACKEND_URL: 'https://ai.example.test',
      DACHENG_RESPONSES_ADAPTER_URL: 'https://responses.example.test',
      TEST_ACCOUNT_TOKEN: testToken,
    },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
});

test('Dacheng AI proxy routes the CLI Codex Responses path for the test account', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const testToken = 'test-account-token-with-at-least-thirty-two-characters';

  globalThis.fetch = async (url) => {
    assert.equal(
      url.toString(),
      'https://responses.example.test/codex-deepseek/v1/responses',
    );
    return new Response(JSON.stringify({ status: 'completed', output: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const response = await handleDachengAiProxy(
    new Request('https://api.ombhrum.com/codex-deepseek/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: 'test', stream: false }),
    }),
    {
      DACHENG_AI_BACKEND_URL: 'https://ai.example.test',
      DACHENG_RESPONSES_ADAPTER_URL: 'https://responses.example.test',
      TEST_ACCOUNT_TOKEN: testToken,
    },
  );
  assert.equal(response.status, 200);
});

test('Dacheng AI proxy keeps ordinary accounts on the existing backend', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    assert.equal(url.toString(), 'https://ai.example.test/v1/ai/usage');
    return new Response(JSON.stringify({ remainingTokens: 10 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const response = await handleDachengAiProxy(
    new Request('https://api.ombhrum.com/v1/ai/usage', {
      headers: { Authorization: 'Bearer ordinary-account-token' },
    }),
    {
      DACHENG_AI_BACKEND_URL: 'https://ai.example.test',
      DACHENG_RESPONSES_ADAPTER_URL: 'https://responses.example.test',
      TEST_ACCOUNT_TOKEN: 'test-account-token-with-at-least-thirty-two-characters',
    },
  );
  assert.equal(response.status, 200);
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

test('Dacheng AI proxy preserves MCP session headers', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.get('mcp-session-id'), 'session-1');
    assert.equal(init.headers.get('mcp-protocol-version'), '2025-06-18');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'session-1',
        'mcp-protocol-version': '2025-06-18',
      },
    });
  };

  const response = await handleDachengAiProxy(
    new Request('https://api.ombhrum.com/api/mcp/apps/global-dharma', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'session-1',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    }),
    { DACHENG_AI_BACKEND_URL: 'https://ai.example.test' },
  );

  assert.equal(response.headers.get('mcp-session-id'), 'session-1');
  assert.match(response.headers.get('access-control-expose-headers') ?? '', /Mcp-Session-Id/i);
});
