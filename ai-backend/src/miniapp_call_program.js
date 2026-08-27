const CALL_PROGRAM_TYPES = new Set(['service-call', 'miniapp-surface']);
const CALL_AI_MODES = new Set(['optional', 'disabled']);
const CALL_ROUTE_ACTIONS = new Set(['command', 'state', 'back', 'end']);
const DTMF_PATTERN = /^[0-9*#]{1,8}$/;
const STATE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function text(value) {
  return String(value ?? '').trim();
}

function requiredText(value, field, max = 500) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function optionalText(value, field, max = 500) {
  const normalized = text(value);
  if (!normalized) return undefined;
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeRoute(value, index, field, commands) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field}.routes[${index}] must be an object`);
  }
  const routeField = `${field}.routes[${index}]`;
  const digits = requiredText(value.digits, `${routeField}.digits`, 8);
  if (!DTMF_PATTERN.test(digits)) throw new Error(`${routeField}.digits is invalid`);

  const inferredAction = value.command ? 'command' : value.nextState ? 'state' : 'end';
  const action = requiredText(value.action ?? inferredAction, `${routeField}.action`, 32).toLocaleLowerCase();
  if (!CALL_ROUTE_ACTIONS.has(action)) throw new Error(`${routeField}.action is invalid`);

  const command = optionalText(value.command, `${routeField}.command`, 64)?.toLocaleLowerCase();
  if (action === 'command') {
    if (!command) throw new Error(`${routeField}.command is required`);
    if (!commands.some((candidate) => candidate.name === command)) {
      throw new Error(`${routeField} references unknown command ${command}`);
    }
  }
  if (value.arguments !== undefined && (!value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments))) {
    throw new Error(`${routeField}.arguments must be an object`);
  }

  const nextState = optionalText(value.nextState, `${routeField}.nextState`, 64)?.toLocaleLowerCase();
  if (action === 'state' && !nextState) throw new Error(`${routeField}.nextState is required`);

  return {
    digits,
    label: optionalText(value.label, `${routeField}.label`, 120),
    action,
    command,
    arguments: value.arguments === undefined ? undefined : clone(value.arguments),
    nextState,
  };
}

function normalizeState(value, index, field, commands) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field}.states[${index}] must be an object`);
  }
  const stateField = `${field}.states[${index}]`;
  const id = requiredText(value.id, `${stateField}.id`, 64).toLocaleLowerCase();
  if (!STATE_ID_PATTERN.test(id)) throw new Error(`${stateField}.id is invalid`);
  const routes = Array.isArray(value.routes)
    ? value.routes.map((route, routeIndex) => normalizeRoute(route, routeIndex, stateField, commands))
    : [];
  if (routes.length > 24) throw new Error(`${stateField} has too many routes`);
  if (new Set(routes.map((route) => route.digits)).size !== routes.length) {
    throw new Error(`${stateField} has duplicate DTMF routes`);
  }
  return {
    id,
    prompt: requiredText(value.prompt, `${stateField}.prompt`, 1000),
    routes,
  };
}

function normalizeProgram(value, kind, surfaces, commands) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`bot.calls.${kind} must be an object`);
  }
  const field = `bot.calls.${kind}`;
  const type = requiredText(value.type ?? 'miniapp-surface', `${field}.type`, 32).toLocaleLowerCase();
  if (!CALL_PROGRAM_TYPES.has(type)) throw new Error(`${field}.type is invalid`);
  const aiMode = requiredText(value.aiMode ?? 'optional', `${field}.aiMode`, 32).toLocaleLowerCase();
  if (!CALL_AI_MODES.has(aiMode)) throw new Error(`${field}.aiMode is invalid`);

  const surfaceId = optionalText(value.surfaceId, `${field}.surfaceId`, 64);
  if (type === 'miniapp-surface') {
    if (!surfaceId) throw new Error(`${field}.surfaceId is required`);
    const surface = surfaces.find((candidate) => candidate.id === surfaceId);
    if (!surface) throw new Error(`${field} references unknown surface ${surfaceId}`);
    if (surface.kind !== 'web') throw new Error(`${field}.surfaceId must reference a web surface`);
  }

  const states = type === 'service-call'
    ? (Array.isArray(value.states) ? value.states.map((state, index) => normalizeState(state, index, field, commands)) : [])
    : [];
  if (type === 'service-call' && states.length === 0) {
    throw new Error(`${field}.states must contain at least one deterministic state`);
  }
  if (states.length > 64) throw new Error(`${field}.states has too many items`);
  const stateIds = new Set(states.map((state) => state.id));
  if (stateIds.size !== states.length) throw new Error(`${field}.states contains duplicate ids`);

  const startState = type === 'service-call'
    ? requiredText(value.startState ?? states[0]?.id, `${field}.startState`, 64).toLocaleLowerCase()
    : undefined;
  if (startState && !stateIds.has(startState)) throw new Error(`${field} references unknown start state ${startState}`);
  for (const state of states) {
    for (const route of state.routes) {
      if (route.nextState && !stateIds.has(route.nextState)) {
        throw new Error(`${field} references unknown next state ${route.nextState}`);
      }
    }
  }

  return {
    protocol: 'fabushi.miniapp.call-program.v1',
    kind,
    type,
    title: requiredText(value.title ?? (kind === 'video' ? '视频服务' : '语音服务'), `${field}.title`, 120),
    aiMode,
    surfaceId,
    startState,
    states,
  };
}

export function normalizeMiniAppBotCalls(value, surfaces = [], commands = []) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('bot.calls must be an object');
  const calls = {};
  if (value.voice !== undefined) calls.voice = normalizeProgram(value.voice, 'voice', surfaces, commands);
  if (value.video !== undefined) calls.video = normalizeProgram(value.video, 'video', surfaces, commands);
  return calls;
}
