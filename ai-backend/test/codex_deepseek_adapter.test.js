import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexResponsesMessages,
  codexResponsesTools,
  deepSeekResultToResponseItems,
} from '../src/codex_deepseek_adapter.js';

test('preserves Codex instructions and tool call history for DeepSeek', () => {
  const messages = codexResponsesMessages({
    instructions: 'Use workspace tools.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Inspect the plugin.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'repo' },
    ],
  });
  assert.deepEqual(messages, [
    { role: 'system', content: 'Use workspace tools.' },
    { role: 'user', content: 'Inspect the plugin.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'repo' },
  ]);
});

test('converts Responses function and custom tools without DSML text', () => {
  const { tools, kinds } = codexResponsesTools({
    tools: [
      { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
      { type: 'custom', name: 'apply_patch', description: 'Patch files' },
    ],
  });
  assert.equal(tools.length, 2);
  assert.equal(tools[0].function.name, 'exec_command');
  assert.equal(tools[1].function.parameters.required[0], 'input');

  let id = 0;
  const items = deepSeekResultToResponseItems({
    message: '',
    toolCalls: [
      { id: 'call_a', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } },
      { id: 'call_b', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } },
    ],
  }, kinds, (prefix) => `${prefix}_${++id}`);
  assert.deepEqual(items, [
    {
      id: 'fc_1', type: 'function_call', call_id: 'call_a', name: 'exec_command',
      arguments: '{"cmd":"pwd"}', status: 'completed',
    },
    {
      id: 'ctc_2', type: 'custom_tool_call', call_id: 'call_b', name: 'apply_patch',
      input: '*** Begin Patch', status: 'completed',
    },
  ]);
});

test('flattens Codex namespace tools for DeepSeek and restores the namespace', () => {
  const { tools, kinds } = codexResponsesTools({
    tools: [{
      type: 'namespace',
      name: 'mahayana',
      description: 'Workspace tools.',
      tools: [{
        type: 'function',
        name: 'read_workspace_file',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }],
    }],
  });
  assert.equal(tools[0].function.name, 'mahayana__read_workspace_file');
  assert.match(tools[0].function.description, /Workspace tools/);

  const messages = codexResponsesMessages({
    input: [{
      type: 'function_call',
      call_id: 'call_namespace',
      namespace: 'mahayana',
      name: 'read_workspace_file',
      arguments: '{"path":"AGENTS.md"}',
    }],
  });
  assert.equal(
    messages[0].tool_calls[0].function.name,
    'mahayana__read_workspace_file',
  );

  const items = deepSeekResultToResponseItems({
    message: '',
    toolCalls: [{
      id: 'call_namespace',
      function: {
        name: 'mahayana__read_workspace_file',
        arguments: '{"path":"AGENTS.md"}',
      },
    }],
  }, kinds, (prefix) => `${prefix}_1`);
  assert.deepEqual(items, [{
    id: 'fc_1',
    type: 'function_call',
    call_id: 'call_namespace',
    name: 'read_workspace_file',
    namespace: 'mahayana',
    arguments: '{"path":"AGENTS.md"}',
    status: 'completed',
  }]);
});

test('uses valid deterministic DeepSeek names for long namespace tools', () => {
  const namespace = `namespace.${'x'.repeat(50)}`;
  const body = {
    tools: [{
      type: 'namespace',
      name: namespace,
      tools: [{
        type: 'function',
        name: `tool.${'y'.repeat(50)}`,
        parameters: { type: 'object', properties: {} },
      }],
    }],
  };
  const first = codexResponsesTools(body).tools[0].function.name;
  const second = codexResponsesTools(body).tools[0].function.name;
  assert.equal(first, second);
  assert.ok(first.length <= 64);
  assert.match(first, /^[a-zA-Z0-9_-]+$/);
});
