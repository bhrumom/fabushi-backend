export const GLOBAL_DHARMA_TOOL_CONTRACT_VERSION = 'fabushi.global-dharma.tools.v1';

const tool = (name, description, {
  readOnly = false,
  destructive = false,
  openWorld = false,
  aliases = [],
  naturalLanguageHints = [],
  usage,
} = {}) => Object.freeze({
  name,
  description,
  annotations: Object.freeze({
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    openWorldHint: openWorld,
  }),
  approval: readOnly ? 'none' : destructive ? 'destructive' : 'required',
  aliases: Object.freeze([...aliases]),
  naturalLanguageHints: Object.freeze([...naturalLanguageHints]),
  ...(usage ? { usage } : {}),
});

export const GLOBAL_DHARMA_TOOL_CONTRACT = Object.freeze([
  tool('home', '加载全球法布施首页。', {
    readOnly: true,
    aliases: ['首页'],
    naturalLanguageHints: ['打开全球法布施', '打开应用', '返回首页'],
  }),
  tool('chat', '处理全球法布施对话与快捷回复。', {
    naturalLanguageHints: ['进入全球发送', '进入本地转经轮', '进入本地场能模式', '确认发送'],
  }),
  tool('start', '启动全球法布施服务。', {
    openWorld: true,
    aliases: ['启动'],
    naturalLanguageHints: ['启动服务', '开始运行'],
  }),
  tool('stop', '停止全球法布施服务。', {
    destructive: true,
    aliases: ['停止'],
    naturalLanguageHints: ['停止服务', '停止运行'],
  }),
  tool('loop', '执行一次法布施调度循环。', {
    openWorld: true,
    aliases: ['循环'],
    naturalLanguageHints: ['执行一次循环', '运行一次调度'],
  }),
  tool('status', '读取全球法布施服务状态。', {
    readOnly: true,
    aliases: ['状态'],
    naturalLanguageHints: ['现在运行到哪里', '查看状态', '运行状态'],
  }),
  tool('send', '发送一条法布施内容。', {
    openWorld: true,
    aliases: ['发送'],
    naturalLanguageHints: ['发送法布施内容', '全球发送'],
    usage: '/global-dharma:send {"content":"..."}',
  }),
  tool('logs', '读取最近运行日志。', {
    readOnly: true,
    aliases: ['日志'],
    naturalLanguageHints: ['查看日志', '最近日志'],
  }),
  tool('validate_config', '验证法布施配置，不执行写入。', {
    readOnly: true,
    aliases: ['验证配置'],
    naturalLanguageHints: ['检查配置', '验证配置'],
  }),
  tool('deploy_latest', '部署最新已验证版本。', {
    openWorld: true,
    aliases: ['部署'],
    naturalLanguageHints: ['部署最新版本', '发布最新版本'],
  }),
]);

const byName = new Map(GLOBAL_DHARMA_TOOL_CONTRACT.map((entry) => [entry.name, entry]));

export function globalDharmaTool(name) {
  return byName.get(String(name ?? '').trim()) ?? null;
}

export function globalDharmaToolAnnotations(name) {
  return globalDharmaTool(name)?.annotations ?? null;
}

export function globalDharmaMarketplaceCommands() {
  return GLOBAL_DHARMA_TOOL_CONTRACT
    .filter((entry) => entry.name !== 'home' && entry.name !== 'chat')
    .map((entry) => ({
    name: entry.name,
    description: entry.description,
    surfaceId: 'remote-mcp',
    tool: entry.name,
    approval: entry.approval,
    aliases: [...entry.aliases],
    naturalLanguageHints: [...entry.naturalLanguageHints],
      ...(entry.usage ? { usage: entry.usage } : {}),
    }));
}
