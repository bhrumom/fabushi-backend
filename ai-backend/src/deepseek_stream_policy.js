const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_TIMEOUT_MS = 90_000;

function boundedTimeout(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  const timeout = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(Math.max(Math.trunc(timeout), minimum), maximum);
}

export function deepSeekFirstTokenTimeoutMs(env = process.env) {
  return boundedTimeout(
    env.DEEPSEEK_FIRST_TOKEN_TIMEOUT_MS,
    DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
    3_000,
    60_000,
  );
}

export function deepSeekStreamTimeoutMs(env = process.env) {
  return boundedTimeout(
    env.DEEPSEEK_STREAM_TIMEOUT_MS,
    DEFAULT_STREAM_TIMEOUT_MS,
    deepSeekFirstTokenTimeoutMs(env),
    5 * 60_000,
  );
}

export function firstTokenTimeoutError(timeoutMs) {
  const error = new Error(`DeepSeek did not produce a first token within ${timeoutMs} ms`);
  error.code = 'DEEPSEEK_FIRST_TOKEN_TIMEOUT';
  error.statusCode = 504;
  error.retryable = true;
  return error;
}

function truncateText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const head = Math.max(0, Math.floor(maxChars * 0.25));
  const tail = Math.max(0, maxChars - head);
  return `${text.slice(0, head)}\n...[older content compacted for retry]...\n${text.slice(-tail)}`;
}

function compactMessage(message, maxChars) {
  if (!message || typeof message !== 'object') return message;
  const next = { ...message };
  if (typeof next.content === 'string') next.content = truncateText(next.content, maxChars);
  if (Array.isArray(next.content)) {
    next.content = next.content.map((part) => (
      part && typeof part === 'object' && typeof part.text === 'string'
        ? { ...part, text: truncateText(part.text, maxChars) }
        : part
    ));
  }
  if (Array.isArray(next.tool_calls)) {
    next.tool_calls = next.tool_calls.map((call) => ({
      ...call,
      function: call?.function
        ? {
            ...call.function,
            arguments: truncateText(call.function.arguments, maxChars),
          }
        : call?.function,
    }));
  }
  return next;
}

/**
 * Fabu-style retry projection: preserve system identity plus the recent turn
 * tail, while dropping old transcript bulk that can make first-token latency
 * explode. The authoritative transcript is never modified.
 */
export function compactDeepSeekMessagesForFirstTokenRetry(
  messages,
  { maxMessages = 10, maxCharsPerMessage = 12_000 } = {},
) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const system = messages.find((message) => message?.role === 'system');
  const tail = messages
    .filter((message) => message !== system)
    .slice(-Math.max(1, maxMessages))
    .map((message) => compactMessage(message, maxCharsPerMessage));
  return system
    ? [compactMessage(system, maxCharsPerMessage), ...tail]
    : tail;
}

export function isFirstTokenTimeout(error) {
  return error?.code === 'DEEPSEEK_FIRST_TOKEN_TIMEOUT';
}
