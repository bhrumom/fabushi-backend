function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.value === 'string') return content.value;
  if (content.content !== undefined) return contentText(content.content);
  return '';
}

function toolOutputText(output) {
  const text = contentText(output);
  if (text) return text;
  if (output === undefined || output === null) return '';
  return typeof output === 'string' ? output : JSON.stringify(output);
}

function stableToolNameHash(value) {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function deepSeekToolName(name, namespace = '') {
  const qualified = namespace ? `${namespace}__${name}` : name;
  const safe = qualified.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (safe.length <= 64) return safe;
  return `${safe.slice(0, 55)}_${stableToolNameHash(qualified)}`;
}

export function codexResponsesMessages(body = {}) {
  const messages = [];
  const instructions = contentText(body.instructions).trim();
  if (instructions) messages.push({ role: 'system', content: instructions });

  const input = typeof body.input === 'string'
    ? [{ role: 'user', content: body.input }]
    : Array.isArray(body.input)
      ? body.input
      : [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const argumentsValue = item.type === 'custom_tool_call'
        ? JSON.stringify({ input: toolOutputText(item.input) })
        : typeof item.arguments === 'string'
          ? item.arguments
          : JSON.stringify(item.arguments || {});
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id,
          type: 'function',
          function: {
            name: deepSeekToolName(item.name, item.namespace),
            arguments: argumentsValue,
          },
        }],
      });
      continue;
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: toolOutputText(item.output),
      });
      continue;
    }
    if (item.type === 'reasoning') continue;
    const role = item.role === 'developer' ? 'system' : item.role;
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) continue;
    const text = contentText(item.content);
    if (text || role === 'assistant') messages.push({ role, content: text });
  }
  return messages;
}

export function codexResponsesTools(body = {}) {
  const tools = [];
  const kinds = new Map();
  for (const item of Array.isArray(body.tools) ? body.tools : []) {
    if (item?.type === 'namespace') {
      const namespace = typeof item.name === 'string' ? item.name.trim() : '';
      if (!namespace) continue;
      for (const nested of Array.isArray(item.tools) ? item.tools : []) {
        const name = typeof nested?.name === 'string' ? nested.name.trim() : '';
        if (!name || nested.type !== 'function') continue;
        const upstreamName = deepSeekToolName(name, namespace);
        kinds.set(upstreamName, { kind: 'function', name, namespace });
        tools.push({
          type: 'function',
          function: {
            name: upstreamName,
            description: [item.description, nested.description].filter(Boolean).join('\n'),
            parameters: nested.parameters || { type: 'object', properties: {} },
          },
        });
      }
      continue;
    }
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name || !['function', 'custom'].includes(item.type)) continue;
    const isCustom = item.type === 'custom';
    const upstreamName = deepSeekToolName(name);
    kinds.set(upstreamName, {
      kind: isCustom ? 'custom' : 'function',
      name,
      namespace: null,
    });
    tools.push({
      type: 'function',
      function: {
        name: upstreamName,
        ...(item.description ? { description: item.description } : {}),
        parameters: isCustom
          ? {
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
              additionalProperties: false,
            }
          : item.parameters || { type: 'object', properties: {} },
      },
    });
  }
  return { tools, kinds };
}

function customToolInput(argumentsValue) {
  try {
    const parsed = JSON.parse(argumentsValue || '{}');
    return typeof parsed?.input === 'string' ? parsed.input : argumentsValue || '';
  } catch {
    return argumentsValue || '';
  }
}

export function deepSeekResultToResponseItems(result, toolKinds, createId) {
  const items = [];
  if (result.message?.trim()) {
    items.push({
      id: createId('msg'),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: result.message.trim() }],
    });
  }
  for (const call of result.toolCalls || []) {
    const upstreamName = call?.function?.name;
    if (!upstreamName) continue;
    const descriptor = toolKinds.get(upstreamName) || {
      kind: 'function',
      name: upstreamName,
      namespace: null,
    };
    const callId = call.id || createId('call');
    const argumentsValue = typeof call.function.arguments === 'string'
      ? call.function.arguments
      : JSON.stringify(call.function.arguments || {});
    if (descriptor.kind === 'custom') {
      items.push({
        id: createId('ctc'),
        type: 'custom_tool_call',
        call_id: callId,
        name: descriptor.name,
        input: customToolInput(argumentsValue),
        status: 'completed',
      });
    } else {
      items.push({
        id: createId('fc'),
        type: 'function_call',
        call_id: callId,
        name: descriptor.name,
        ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
        arguments: argumentsValue,
        status: 'completed',
      });
    }
  }
  return items;
}
