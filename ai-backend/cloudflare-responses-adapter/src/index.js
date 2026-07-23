import {
  codexResponsesMessages,
  codexResponsesTools,
  deepSeekResultToResponseItems,
} from '../../src/codex_deepseek_adapter.js';

const JSON_HEADERS = {
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function bearerToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

async function digest(value) {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || ''))),
  );
}

async function constantTimeEqual(left, right) {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest[index] ^ rightDigest[index];
  }
  return difference === 0;
}

async function authorizeTestAccount(request, env) {
  const expected = String(env.TEST_ACCOUNT_TOKEN || '').trim();
  const actual = bearerToken(request);
  return Boolean(expected && actual && await constantTimeEqual(actual, expected));
}

function normalizeModel(value, fallback = 'deepseek-chat') {
  const raw = String(value || fallback).trim();
  return raw.includes('/') ? raw.split('/').pop() || fallback : raw || fallback;
}

function clampMaxTokens(value, maximum) {
  const parsed = Number(value || maximum);
  if (!Number.isFinite(parsed) || parsed < 1) return maximum;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

function usage(result = {}) {
  const promptTokens = Number(result.prompt_tokens || result.input_tokens || 0);
  const completionTokens = Number(result.completion_tokens || result.output_tokens || 0);
  return {
    input_tokens: promptTokens,
    cached_input_tokens: 0,
    output_tokens: completionTokens,
    reasoning_output_tokens: 0,
    total_tokens: Number(result.total_tokens || promptTokens + completionTokens),
  };
}

function responsePayload({ id, model, output, status = 'completed', resultUsage, error }) {
  return {
    id,
    object: 'response',
    status,
    model,
    output: status === 'completed' ? output : [],
    ...(resultUsage ? { usage: usage(resultUsage) } : {}),
    ...(error ? { error: { type: 'server_error', message: error } } : {}),
  };
}

function compact(value, maximum) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maximum) return text;
  return `[前文省略]${text.slice(-maximum)}`;
}

function compactBalanced(value, maximum) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maximum) return text;
  const marker = '[中间省略]';
  const available = Math.max(2, maximum - marker.length);
  const headLength = Math.ceil(available / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(-(available - headLength))}`;
}

function compactToolParameters(parameters = {}) {
  return {
    args: parameters?.properties && typeof parameters.properties === 'object'
      ? Object.keys(parameters.properties)
      : [],
    required: Array.isArray(parameters?.required) ? parameters.required : [],
  };
}

function relevantTools(tools) {
  const interactiveName = /(computer|node_repl|browser|chrome|view_image)/i;
  const operationalName = /(workspace|file|directory|command|app|plugin|deploy|publish|test|pack|market|read|write|list|exec|shell|mcp|node|repl)/i;
  const ranked = [
    ...tools.filter((tool) => interactiveName.test(tool.function.name)),
    ...tools.filter((tool) =>
      !interactiveName.test(tool.function.name) && operationalName.test(tool.function.name),
    ),
    ...tools.filter((tool) => !operationalName.test(tool.function.name)),
  ];
  const selected = [];
  let length = 2;
  for (const tool of ranked.slice(0, 48)) {
    const item = {
      alias: `t${selected.length}`,
      name: tool.function.name,
      description: compact(tool.function.description, 32),
      ...compactToolParameters(tool.function.parameters),
    };
    const serializedLength = JSON.stringify(item).length + 1;
    if (selected.length > 0 && length + serializedLength > 1150) continue;
    selected.push(item);
    length += serializedLength;
  }
  return selected;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
  );
}

function parsedArguments(value) {
  if (typeof value !== 'string') return value || {};
  try {
    return JSON.parse(value || '{}');
  } catch {
    return value.trim();
  }
}

function canonicalArguments(value) {
  const parsed = parsedArguments(value);
  return typeof parsed === 'string' ? parsed : JSON.stringify(canonicalJson(parsed));
}

function toolCallSignature(name, argumentsValue) {
  const parsed = parsedArguments(argumentsValue);
  const normalizedName = String(name || '');
  let significantArguments = parsed;
  if (
    /(?:^|__)exec_command$|(?:^|__)shell_command$/.test(normalizedName) &&
    parsed && typeof parsed === 'object' && typeof parsed.cmd === 'string'
  ) {
    significantArguments = { cmd: parsed.cmd };
  } else if (
    /(?:^|__)read_mcp_resource$/.test(normalizedName) &&
    parsed && typeof parsed === 'object' && typeof parsed.uri === 'string'
  ) {
    significantArguments = { uri: parsed.uri };
  }
  return `${normalizedName}:${canonicalArguments(significantArguments)}`;
}

function completedToolCalls(messages) {
  return messages
    .filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
    .flatMap((message) => message.tool_calls)
    .filter((call) => call?.function?.name)
    .map((call) => ({
      name: call.function.name,
      arguments: canonicalArguments(call.function.arguments),
      signature: toolCallSignature(call.function.name, call.function.arguments),
    }));
}

function recentToolTrace(messages) {
  const calls = new Map();
  const trace = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!call?.id || !call?.function?.name) continue;
        calls.set(call.id, {
          name: call.function.name,
          arguments: canonicalArguments(call.function.arguments),
        });
      }
    } else if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id) || { name: 'unknown', arguments: '{}' };
      trace.push({
        ...call,
        result: String(message.content || ''),
      });
    }
  }
  const recent = trace.slice(-4);
  return recent.map((item, index) => ({
    ...item,
    result: compactBalanced(item.result, index === recent.length - 1 ? 1400 : 300),
  }));
}

function toolRouterPrompt(messages, tools) {
  const latestUser = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
  const completedCalls = completedToolCalls(messages).slice(-8);
  const toolTrace = recentToolTrace(messages);
  const aliases = new Map();
  const available = relevantTools(tools);
  available.forEach((item) => aliases.set(item.alias, item.name));
  const prompt = [
    completedCalls.length ? `本轮已完成调用:${JSON.stringify(completedCalls.map(({ name, arguments: args }) => ({ name, arguments: args })))}` : '',
    toolTrace.length ? `最近工具轨迹（包含仍然有效的较早成功结果）:${JSON.stringify(toolTrace)}` : '',
    `用户原始目标:${compact(latestUser, 620)}`,
    '你是 Codex 工具路由器。按真实工具 name 和参数选择下一步；读取/列出绝不能用 create/generate，路径必须原样保留。任务需要本地事实、修改、测试、部署或电脑观察时必须调用工具，不能声称无权限或让用户手动做。上一调用成功后必须推进到下一步，严禁重复本轮已完成的相同工具和参数。只要工具轨迹中的成功结果已经提供目标事实，立即返回 content，不再换工具重复读取。本地文件使用 exec_command；read_mcp_resource 只允许使用 list_mcp_resources 真实返回的 server 和 uri，绝不猜 server 或伪造 file URI。',
    '只输出一个JSON对象。调用:{"tool":"t0","arguments":{...}}；全部完成:{"content":"最终答复"}。一次一个工具，不要Markdown。',
    `可用工具:${JSON.stringify(available)}`,
  ].filter(Boolean).join('\n');
  return { prompt: compact(prompt, 4800), aliases };
}

function parseToolRouterResult(content, aliases) {
  const cleaned = String(content || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { message: cleaned, toolCalls: [] };
  }
  const requestedTool = String(parsed?.tool || '');
  const upstreamName = aliases.get(requestedTool) ||
    [...aliases.values()].find((name) =>
      name === requestedTool || name.endsWith(`__${requestedTool}`),
    );
  if (!upstreamName) {
    return { message: String(parsed?.content || cleaned).trim(), toolCalls: [] };
  }
  return {
    message: '',
    toolCalls: [{
      id: `call_${crypto.randomUUID().replaceAll('-', '')}`,
      type: 'function',
      function: {
        name: upstreamName,
        arguments: JSON.stringify(
          parsed?.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {},
        ),
      },
    }],
  };
}

async function callDeepSeekProxy(messages, tools, model, maximum, env) {
  const { prompt, aliases } = toolRouterPrompt(messages, tools);
  const completedSignatures = new Set(completedToolCalls(messages).map((call) => call.signature));
  const aggregateUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retryInstruction = attempt > 0
      ? `\n纠错${attempt}: 你刚才选择了已经成功完成的相同调用。禁止重复；必须根据最近工具结果推进到下一步，或在目标已完成时返回 content。`
      : '';
    const upstream = await fetch(env.DEEPSEEK_PROXY_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${env.TEST_ACCOUNT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: maximum,
        messages: [{ role: 'user', content: `${prompt}${retryInstruction}` }],
      }),
    });
    const text = await upstream.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: { message: text } };
    }
    if (!upstream.ok) {
      const error = new Error(
        payload?.error?.message || payload?.message || `DeepSeek proxy failed: ${upstream.status}`,
      );
      error.status = upstream.status;
      throw error;
    }
    for (const key of Object.keys(aggregateUsage)) {
      aggregateUsage[key] += Number(payload?.usage?.[key] || 0);
    }
    const content = payload?.choices?.[0]?.message?.content || '';
    const result = tools.length
      ? parseToolRouterResult(content, aliases)
      : { message: String(content).trim(), toolCalls: [] };
    if (!result.message && result.toolCalls.length === 0) {
      const error = new Error('DeepSeek proxy returned an empty response');
      error.status = 502;
      throw error;
    }
    const repeated = result.toolCalls.some((call) => completedSignatures.has(
      toolCallSignature(call.function.name, call.function.arguments),
    ));
    if (!repeated) return { result, resultUsage: aggregateUsage, model };
  }

  const finalizerPrompt = [
    `用户目标:${compact([...messages].reverse().find((message) => message.role === 'user')?.content, 800)}`,
    `已取得的真实工具轨迹:${JSON.stringify(recentToolTrace(messages))}`,
    '工具阶段已经结束。只能依据以上真实结果回答；禁止输出 tool 字段、工具调用或命令，禁止声称未发生的操作。只输出 {"content":"最终答复"}。若事实不足，在 content 中准确说明缺少什么。',
  ].join('\n');
  const finalizer = await fetch(env.DEEPSEEK_PROXY_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${env.TEST_ACCOUNT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: maximum,
      messages: [{ role: 'user', content: finalizerPrompt }],
    }),
  });
  const finalizerText = await finalizer.text();
  let finalizerPayload;
  try {
    finalizerPayload = finalizerText ? JSON.parse(finalizerText) : {};
  } catch {
    finalizerPayload = { error: { message: finalizerText } };
  }
  if (!finalizer.ok) {
    const error = new Error(
      finalizerPayload?.error?.message ||
      finalizerPayload?.message ||
      `DeepSeek finalizer failed: ${finalizer.status}`,
    );
    error.status = finalizer.status;
    throw error;
  }
  for (const key of Object.keys(aggregateUsage)) {
    aggregateUsage[key] += Number(finalizerPayload?.usage?.[key] || 0);
  }
  const finalizerContent = finalizerPayload?.choices?.[0]?.message?.content || '';
  const finalResult = parseToolRouterResult(finalizerContent, new Map());
  if (finalResult.message) {
    return { result: finalResult, resultUsage: aggregateUsage, model };
  }
  const error = new Error('DeepSeek repeatedly selected an already completed tool call');
  error.status = 508;
  throw error;
}

async function callDeepSeekDirect(messages, tools, model, maximum, env) {
  const upstream = await fetch(
    `${String(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: maximum,
        stream: false,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
    },
  );

  const text = await upstream.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: { message: text } };
  }
  if (!upstream.ok) {
    const error = new Error(
      payload?.error?.message || payload?.message || `DeepSeek request failed: ${upstream.status}`,
    );
    error.status = upstream.status;
    throw error;
  }

  const message = payload?.choices?.[0]?.message || {};
  const result = {
    message: typeof message.content === 'string' ? message.content.trim() : '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
  };
  if (!result.message && result.toolCalls.length === 0) {
    const error = new Error('DeepSeek returned an empty response');
    error.status = 502;
    throw error;
  }

  return { result, resultUsage: payload.usage || {}, model };
}

async function callDeepSeek(body, env) {
  const messages = codexResponsesMessages(body);
  if (messages.length === 0) {
    const error = new Error('Responses input is required');
    error.status = 400;
    throw error;
  }
  const { tools, kinds } = codexResponsesTools(body);
  const model = normalizeModel(body.model, env.DEEPSEEK_MODEL);
  const configuredMaximum = Math.max(
    1,
    Math.min(12_000, Number(env.MAX_COMPLETION_TOKENS || 6000)),
  );
  const maximum = clampMaxTokens(
    body.max_output_tokens || body.max_tokens,
    configuredMaximum,
  );
  const upstream = env.DEEPSEEK_API_KEY
    ? await callDeepSeekDirect(messages, tools, model, maximum, env)
    : await callDeepSeekProxy(messages, tools, model, maximum, env);
  return { ...upstream, kinds };
}

function event(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function streamingResponse({ responseId, model, output, resultUsage }) {
  const chunks = [];
  chunks.push(event('response.created', {
    type: 'response.created',
    response: responsePayload({ id: responseId, model, output: [], status: 'in_progress' }),
  }));
  output.forEach((item, outputIndex) => {
    chunks.push(event('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: item.type === 'message'
        ? { ...item, status: 'in_progress', content: [] }
        : { ...item, status: 'in_progress' },
    }));
    if (item.type === 'message') {
      const text = item.content?.find((part) => part.type === 'output_text')?.text || '';
      if (text) {
        chunks.push(event('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          delta: text,
        }));
      }
    }
    chunks.push(event('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item,
    }));
  });
  chunks.push(event('response.completed', {
    type: 'response.completed',
    response: responsePayload({ id: responseId, model, output, resultUsage }),
  }));

  return new Response(chunks.join(''), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      'Cache-Control': 'no-cache, no-transform',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
}

function usageStatus() {
  const now = new Date();
  return {
    windowStart: Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000),
    windowEnd: Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000),
    tokenLimit: 999_999_999,
    usedTokens: 0,
    reservedTokens: 0,
    remainingTokens: 999_999_999,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
    if (!env.TEST_ACCOUNT_TOKEN || (!env.DEEPSEEK_API_KEY && !env.DEEPSEEK_PROXY_URL)) {
      return json({ error: { message: 'Responses adapter is not configured' } }, 503);
    }
    if (!await authorizeTestAccount(request, env)) {
      return json({ error: { message: 'Unauthorized test account' } }, 401);
    }

    const pathname = new URL(request.url).pathname;
    if (request.method === 'GET' && pathname.endsWith('/usage')) return json(usageStatus());
    if (request.method !== 'POST' || !pathname.endsWith('/responses')) {
      return json({ error: { message: 'Not found' } }, 404);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: { message: 'Invalid JSON request' } }, 400);
    }

    try {
      const { result, resultUsage, kinds, model } = await callDeepSeek(body, env);
      const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;
      const output = deepSeekResultToResponseItems(
        result,
        kinds,
        (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`,
      );
      const wantsStream = body.stream !== false ||
        (request.headers.get('Accept') || '').includes('text/event-stream');
      if (wantsStream) {
        return streamingResponse({ responseId, model, output, resultUsage });
      }
      return json(responsePayload({ id: responseId, model, output, resultUsage }));
    } catch (error) {
      const status = Number(error?.status || 500);
      return json({ error: { type: 'server_error', message: error?.message || String(error) } }, status);
    }
  },
};
