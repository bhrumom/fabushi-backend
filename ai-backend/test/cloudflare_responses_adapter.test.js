import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../cloudflare-responses-adapter/src/index.js';

const env = {
  DEEPSEEK_API_KEY: 'deepseek-test-key',
  TEST_ACCOUNT_TOKEN: 'test-account-token',
  DEEPSEEK_BASE_URL: 'https://deepseek.example.test',
  DEEPSEEK_MODEL: 'deepseek-chat',
  MAX_COMPLETION_TOKENS: '6000',
};

function request(path, options = {}) {
  return new Request(`https://adapter.example.test${path}`, options);
}

test('Cloudflare adapter rejects non-test credentials', async () => {
  const response = await worker.fetch(request('/v1/ai/usage', {
    headers: { Authorization: 'Bearer wrong-token' },
  }), env);
  assert.equal(response.status, 401);
});

test('Cloudflare adapter exposes unlimited test-account usage', async () => {
  const response = await worker.fetch(request('/v1/ai/usage', {
    headers: { Authorization: 'Bearer test-account-token' },
  }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.tokenLimit, 999_999_999);
  assert.equal(payload.usedTokens, 0);
  assert.equal(payload.remainingTokens, 999_999_999);
});

test('Cloudflare adapter sends Codex tools to DeepSeek and returns a Responses tool call', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: 'deepseek-chat',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-read',
            type: 'function',
            function: {
              name: 'mahayana__read_workspace_file',
              arguments: '{"path":"plugin.json"}',
            },
          }],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await worker.fetch(request('/v1/ai/responses', {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        Authorization: 'Bearer test-account-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: '读取插件' }] }],
        tools: [{
          type: 'function',
          name: 'mahayana__read_workspace_file',
          description: 'Read a workspace file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        }],
      }),
    }), env);

    assert.equal(response.status, 200);
    assert.equal(upstreamBody.tools[0].function.name, 'mahayana__read_workspace_file');
    const events = await response.text();
    assert.match(events, /response\.output_item\.done/);
    assert.match(events, /"type":"function_call"/);
    assert.match(events, /"name":"mahayana__read_workspace_file"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloudflare adapter restores a tool call routed through the production DeepSeek proxy', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: 'deepseek-chat',
      choices: [{
        message: {
          role: 'assistant',
          content: '{"tool":"t0","arguments":{"path":"plugin.json"}}',
        },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await worker.fetch(request('/v1/ai/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-account-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        stream: false,
        input: [{ role: 'user', content: [{ type: 'input_text', text: '读取插件' }] }],
        tools: [{
          type: 'function',
          name: 'mahayana__read_workspace_file',
          description: 'Read a workspace file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        }],
      }),
    }), {
      ...env,
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_PROXY_URL: 'https://ai.example.test/chat/completions',
    });

    assert.equal(response.status, 200);
    assert.match(upstreamBody.messages[0].content, /"alias":"t0"/);
    assert.match(upstreamBody.messages[0].content, /"name":"mahayana__read_workspace_file"/);
    const payload = await response.json();
    assert.equal(payload.output[0].type, 'function_call');
    assert.equal(payload.output[0].name, 'mahayana__read_workspace_file');
    assert.deepEqual(JSON.parse(payload.output[0].arguments), { path: 'plugin.json' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloudflare adapter accepts a real tool name when DeepSeek ignores its short alias', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: '{"tool":"mahayana__read_workspace_file","arguments":{"path":"plugin.json"}}',
      },
    }],
    usage: { total_tokens: 10 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const response = await worker.fetch(request('/v1/ai/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-account-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        stream: false,
        input: '读取插件',
        tools: [{
          type: 'function',
          name: 'mahayana__read_workspace_file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        }],
      }),
    }), {
      ...env,
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_PROXY_URL: 'https://ai.example.test/chat/completions',
    });
    const payload = await response.json();
    assert.equal(payload.output[0].type, 'function_call');
    assert.equal(payload.output[0].name, 'mahayana__read_workspace_file');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloudflare adapter rejects a completed duplicate call and asks DeepSeek for the next step', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  globalThis.fetch = async (_url, options) => {
    upstreamBodies.push(JSON.parse(options.body));
    const content = upstreamBodies.length === 1
      ? '{"tool":"exec_command","arguments":{"cmd":"find plugin","workdir":"/"}}'
      : '{"tool":"exec_command","arguments":{"cmd":"sed -n 1,220p plugin.json"}}';
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await worker.fetch(request('/v1/ai/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-account-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        stream: false,
        input: [
          { role: 'user', content: '先 find plugin，再读取 plugin.json' },
          {
            type: 'function_call',
            call_id: 'call-find',
            name: 'exec_command',
            arguments: '{"cmd":"find plugin"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call-find',
            output: 'plugin/plugin.json',
          },
        ],
        tools: [{
          type: 'function',
          name: 'exec_command',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd'],
          },
        }],
      }),
    }), {
      ...env,
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_PROXY_URL: 'https://ai.example.test/chat/completions',
    });

    assert.equal(upstreamBodies.length, 2);
    assert.match(upstreamBodies[0].messages[0].content, /本轮已完成调用/);
    assert.match(upstreamBodies[0].messages[0].content, /最近工具轨迹/);
    assert.match(upstreamBodies[0].messages[0].content, /plugin\/plugin\.json/);
    assert.match(upstreamBodies[0].messages[0].content, /严禁重复/);
    assert.match(upstreamBodies[1].messages[0].content, /纠错1/);
    const payload = await response.json();
    assert.equal(payload.output[0].type, 'function_call');
    assert.deepEqual(JSON.parse(payload.output[0].arguments), {
      cmd: 'sed -n 1,220p plugin.json',
    });
    assert.equal(payload.usage.total_tokens, 30);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloudflare adapter treats guessed MCP servers for the same URI as a repeated read', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    const content = upstreamCalls === 1
      ? '{"tool":"read_mcp_resource","arguments":{"server":"filesystem_local","uri":"file:///plugin.json"}}'
      : '{"content":"读取失败，未发现已注册的 filesystem MCP server。"}';
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { total_tokens: 10 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await worker.fetch(request('/v1/ai/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-account-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        stream: false,
        input: [
          { role: 'user', content: '读取 plugin.json' },
          {
            type: 'function_call',
            call_id: 'call-read',
            name: 'read_mcp_resource',
            arguments: '{"server":"filesystem","uri":"file:///plugin.json"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call-read',
            output: "resources/read failed: unknown MCP server 'filesystem'",
          },
        ],
        tools: [{
          type: 'function',
          name: 'read_mcp_resource',
          parameters: {
            type: 'object',
            properties: {
              server: { type: 'string' },
              uri: { type: 'string' },
            },
            required: ['server', 'uri'],
          },
        }],
      }),
    }), {
      ...env,
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_PROXY_URL: 'https://ai.example.test/chat/completions',
    });

    assert.equal(upstreamCalls, 2);
    const payload = await response.json();
    assert.equal(payload.output[0].type, 'message');
    assert.match(payload.output[0].content[0].text, /未发现已注册/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloudflare adapter preserves a complete recent manifest result for final reasoning', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"content":"chatgpt-auto-confirm 1.0.0 cli/desktop"}' } }],
      usage: { total_tokens: 10 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const manifest = JSON.stringify({
    name: 'chatgpt-auto-confirm',
    version: '1.0.0',
    description: 'x'.repeat(700),
    runtimeVariants: [{ platforms: ['cli', 'desktop'] }],
  });
  try {
    const response = await worker.fetch(request('/v1/ai/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-account-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        stream: false,
        input: [
          { role: 'user', content: '报告 name、version、platforms' },
          {
            type: 'function_call',
            call_id: 'call-cat',
            name: 'exec_command',
            arguments: '{"cmd":"cat plugin.json"}',
          },
          { type: 'function_call_output', call_id: 'call-cat', output: manifest },
        ],
        tools: [{
          type: 'function',
          name: 'exec_command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        }],
      }),
    }), {
      ...env,
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_PROXY_URL: 'https://ai.example.test/chat/completions',
    });

    assert.equal(response.status, 200);
    assert.match(upstreamBody.messages[0].content, /chatgpt-auto-confirm/);
    assert.match(upstreamBody.messages[0].content, /1\.0\.0/);
    assert.match(upstreamBody.messages[0].content, /cli/);
    assert.match(upstreamBody.messages[0].content, /desktop/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloudflare adapter finalizes from real tool results after three duplicate selections', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    const content = upstreamCalls <= 3
      ? '{"tool":"exec_command","arguments":{"cmd":"cat plugin.json"}}'
      : '{"content":"name=chatgpt-auto-confirm, version=1.0.0, platforms=cli/desktop"}';
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await worker.fetch(request('/v1/ai/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-account-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        stream: false,
        input: [
          { role: 'user', content: '报告插件字段' },
          {
            type: 'function_call',
            call_id: 'call-cat',
            name: 'exec_command',
            arguments: '{"cmd":"cat plugin.json"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call-cat',
            output: '{"name":"chatgpt-auto-confirm","version":"1.0.0","runtimeVariants":[{"platforms":["cli","desktop"]}]}',
          },
        ],
        tools: [{
          type: 'function',
          name: 'exec_command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        }],
      }),
    }), {
      ...env,
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_PROXY_URL: 'https://ai.example.test/chat/completions',
    });

    assert.equal(upstreamCalls, 4);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.output[0].type, 'message');
    assert.match(payload.output[0].content[0].text, /chatgpt-auto-confirm/);
    assert.equal(payload.usage.total_tokens, 24);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloudflare adapter keeps node_repl visible when many MCP tools compete for prompt space', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"tool":"mcp__node_repl__js","arguments":{"code":"1+1"}}' } }],
      usage: { total_tokens: 10 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const tools = Array.from({ length: 60 }, (_, index) => ({
    type: 'function',
    name: `mcp__noise__read_item_${index}`,
    description: 'Read a noisy MCP item',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
  }));
  tools.push({
    type: 'function',
    name: 'mcp__node_repl__js',
    description: 'Control desktop apps through Computer Use',
    parameters: { type: 'object', properties: { code: { type: 'string' } } },
  });

  try {
    const response = await worker.fetch(request('/v1/ai/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-account-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ stream: false, input: '使用 Computer Use', tools }),
    }), {
      ...env,
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_PROXY_URL: 'https://ai.example.test/chat/completions',
    });

    assert.match(upstreamBody.messages[0].content, /mcp__node_repl__js/);
    const payload = await response.json();
    assert.equal(payload.output[0].name, 'mcp__node_repl__js');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
