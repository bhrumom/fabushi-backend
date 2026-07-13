export function extractMiniAppHtml(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';

  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const startMatch = /<!doctype\s+html|<html[\s>]/i.exec(candidate);
  if (!startMatch) return '';

  const htmlEnd = candidate.toLowerCase().lastIndexOf('</html>');
  if (htmlEnd < startMatch.index) return '';

  const document = candidate
    .slice(startMatch.index, htmlEnd + '</html>'.length)
    .trim();
  if (!/<body[\s>]/i.test(document)) return '';
  return /^<!doctype\s+html/i.test(document)
    ? document
    : `<!doctype html>\n${document}`;
}

export function isBotFatherGenerationMessages(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!message || message.role !== 'system') return false;
    const content = typeof message.content === 'string' ? message.content : '';
    return /Fabushi\s*机器人之父/i.test(content);
  });
}

const botFatherIntentActions = new Set([
  'create_miniapp',
  'clarify',
  'chat',
]);

function readIntentText(value, maxLength = 1200) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function parseJsonObject(value) {
  const text = readIntentText(value, 12_000);
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const objectStart = candidate.indexOf('{');
  const objectEnd = candidate.lastIndexOf('}');
  if (objectStart < 0 || objectEnd <= objectStart) return null;

  try {
    const parsed = JSON.parse(candidate.slice(objectStart, objectEnd + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function parseBotFatherIntent(value) {
  const payload = parseJsonObject(value);
  if (!payload) return null;

  const action = readIntentText(payload.action, 40).toLowerCase();
  if (!botFatherIntentActions.has(action)) return null;

  const confidenceValue = Number(payload.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : null;

  const title = readIntentText(payload.title, 48);
  const requirement = readIntentText(
    payload.requirement || payload.normalizedRequirement,
    4000,
  );
  const reply = readIntentText(payload.reply, 1200);

  if (action === 'create_miniapp' && !requirement) return null;
  if (action !== 'create_miniapp' && !reply) return null;

  return {
    action,
    confidence,
    title,
    requirement,
    reply,
  };
}
