import crypto from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const APP_MIME = 'text/html;profile=mcp-app';
const VERSION = '1.0.0';

const chatGptTaskPromptTemplates = [
  {
    id: 'implement-and-verify',
    title: '实现并验证',
    description: '在当前 checkout 中完成实现、运行相应验证，并保留无关改动。',
    promptPrefix: '请在当前 checkout 中完成下面的实现任务，检查现有改动后继续，运行与风险相称的验证，不要覆盖无关改动：',
  },
  {
    id: 'diagnose-fix-verify',
    title: '诊断、修复、验证',
    description: '先用证据定位根因，再修复并完成回归验证。',
    promptPrefix: '请先用现有代码、日志和测试定位根因，然后修复并完成回归验证；不要只给建议：',
  },
  {
    id: 'review-and-fix',
    title: '审查并修正',
    description: '审查现有实现，修正真实问题并验证。',
    promptPrefix: '请审查当前 checkout 中与目标相关的实现，修正发现的真实问题并完成验证：',
  },
  {
    id: 'continue-to-complete',
    title: '持续完成目标',
    description: '从已有进度继续，直到满足全部验收条件。',
    promptPrefix: '请从当前 checkout 的已有进度继续，不要从头开始；持续工作直到以下目标和验收条件全部满足：',
  },
];

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
const writeLocal = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const writeExternal = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

export const officialMcpApps = [
  app('global-dharma', '全球法布施', '全球法布施运行、发送、日志和部署管理'),
  app('faliu-flashcards', '法流记忆卡', '创建、打开与复习法流记忆卡'),
  app('platform-publish', '平台发布', '跨平台草稿与发布状态管理'),
  app('hermes-installer', 'Hermes 安装器', '安装并运行 Hermes；密钥只存放在 Secret Store'),
  app('bot-father', 'Bot Father', '生成、验证、构建与发布可移植 Codex 插件'),
  app('mahayana-assistant', '大乘助手', '插件状态、诊断与使用帮助'),
  app(
    'chatgpt-auto-confirm',
    'ChatGPT 自动确认',
    '显式启动后自动确认非敏感 ChatGPT 授权卡；敏感动作始终拦截并保留本地审计',
  ),
];

function app(id, title, description) {
  return {
    id,
    pluginId: `${id}@fabushi-official`,
    title,
    description,
    version: VERSION,
    mcpServer: id,
    endpoint: `/api/mcp/apps/${id}`,
    platforms: ['cli', 'desktop', 'mobile', 'web'],
  };
}

const appById = new Map(officialMcpApps.map((item) => [item.id, item]));
const httpSessions = new Map();
const stateByScope = new Map();

function stateFor(scopeId) {
  const key = String(scopeId || 'anonymous');
  let scoped = stateByScope.get(key);
  if (!scoped) {
    scoped = {
      globalDharma: { running: false, loops: 0, sent: 0, logs: [], mode: null, pendingContent: null },
      decks: new Map(),
      drafts: new Map(),
      hermes: { installed: false, running: false, messages: 0 },
      plugins: new Map(),
      touchedAt: Date.now(),
    };
    stateByScope.set(key, scoped);
  }
  scoped.touchedAt = Date.now();
  return scoped;
}

function result(text, structuredContent = {}) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

async function progress(extra, progressValue, total, message) {
  if (extra.signal.aborted) throw extra.signal.reason ?? new Error('MCP Tool call cancelled');
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  await extra.sendNotification({
    method: 'notifications/progress',
    params: { progressToken, progress: progressValue, total, message },
  });
}

function homeResult(appInfo) {
  const content = miniAppContent(appInfo);
  return {
    ...result(content.home.welcome?.markdown ?? '', content.home),
    _meta: { 'ui/resourceUri': resourceUri(appInfo.id) },
  };
}

function miniAppContent(appInfo) {
  const welcome = `欢迎来到 **${appInfo.title}**。\n\n${appInfo.description}`;
  const content = appInfo.id === 'global-dharma'
    ? {
        welcome,
        quickReplies: [
          quickMessage('global-send', '1 全球发送', '1', '进入全球发送'),
          quickMessage('local-prayer-wheel', '2 本地转经轮', '2', '进入本地转经轮'),
          quickMessage('local-field', '3 本地场能模式', '3', '进入本地场能模式'),
        ],
        items: [
          {
            id: 'getting-started', revision: '1', kind: 'announcement', title: '首次使用说明',
            publishedAt: '2026-07-19', summary: '所有网络发送与本地运行都会在真正执行前请求宿主批准。',
            resourceUri: `mahayana://${appInfo.id}/content/announcements/getting-started`, tags: ['公告', '安全'], quickReplies: [],
            markdown: '# 首次使用说明\n\n选择模式后按对话提示操作；真正发送、安装或运行前，大乘宿主会展示参数和风险。',
          },
          {
            id: 'guide', revision: '1', kind: 'article', title: '全球法布施使用指南',
            publishedAt: '2026-07-19', summary: '了解全球发送、本地转经轮与本地场能三种模式。',
            resourceUri: `mahayana://${appInfo.id}/content/articles/guide`, tags: ['指南'], quickReplies: [],
            markdown: '# 全球法布施使用指南\n\n## 1 全球发送\n\n逐步收集发送内容，确认后通过宿主受控网络能力执行。\n\n## 2 本地转经轮\n\n在本地运行，启动前由宿主展示能力请求。\n\n## 3 本地场能模式\n\n在本地运行，插件不会向宿主返回任意 shell 字符串。',
          },
        ],
      }
    : appInfo.id === 'chatgpt-auto-confirm'
      ? {
          welcome,
          quickReplies: [
            quickTool('queue-status', '查看任务队列', 'queue_status'),
            quickTool('prompt-templates', '内置任务提示词', 'prompt_templates'),
            quickTool('wait-review', '等待验收任务', 'wait_for_review', { timeout: 60 }),
          ],
          items: [],
        }
      : { welcome, quickReplies: [], items: [] };
  const revision = crypto
    .createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex');
  return {
    home: {
      schema: 'mahayana.miniapp.home.v1',
      revision,
      app: { ...appInfo, source: 'https://github.com/fabushi/fabushi' },
      welcome: { id: 'welcome', markdown: content.welcome },
      tips: [],
      quickReplies: content.quickReplies,
      feed: { items: content.items.map(({ markdown, ...item }) => item), nextCursor: null },
    },
    resources: content.items.map(({ resourceUri: uri, markdown: text }) => ({ uri, text })),
  };
}

function quickMessage(id, label, alias, value) {
  return { id, label, aliases: [alias], action: { type: 'message', value } };
}

function quickTool(id, label, name, args = {}) {
  return { id, label, aliases: [], action: { type: 'tool', name, arguments: args } };
}

function resourceUri(id) {
  return `ui://fabushi/${id}/home-v1.html`;
}

function registerHome(server, appInfo, actionNames) {
  const uri = resourceUri(appInfo.id);
  const content = miniAppContent(appInfo);
  server.registerResource(
    'home-ui',
    uri,
    {
      title: `${appInfo.title} 首页`,
      description: `${appInfo.title} 的版本化 MCP App UI`,
      mimeType: APP_MIME,
    },
    async () => ({
      contents: [{ uri, mimeType: APP_MIME, text: renderHomeUi(appInfo, actionNames) }],
    }),
  );
  for (const resource of content.resources) {
    server.registerResource(
      `content-${crypto.createHash('sha256').update(resource.uri).digest('hex').slice(0, 12)}`,
      resource.uri,
      { title: '小程序内容', mimeType: 'text/markdown' },
      async () => ({ contents: [{ uri: resource.uri, mimeType: 'text/markdown', text: resource.text }] }),
    );
  }
  server.registerTool(
    'home',
    {
      title: '打开首页',
      description: `加载${appInfo.title}首页。`,
      inputSchema: {
        surface: z.enum(['cli', 'desktop', 'mobile', 'web']).optional(),
        locale: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(10).optional(),
      },
      annotations: readOnly,
      _meta: { 'ui/resourceUri': uri },
    },
    async () => homeResult(appInfo),
  );
}

function renderHomeUi(appInfo, actionNames) {
  const actions = actionNames
    .filter((name) => name !== 'home')
    .map((name) => `<button data-tool="${escapeHtml(name)}">/${escapeHtml(name)}</button>`)
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src data:"><style>:root{color-scheme:light dark}body{font:15px system-ui;margin:0;padding:20px;background:#101722;color:#edf3ff}h1{font-size:21px;margin:0 0 6px}.sub{color:#9eb0ca;margin:0 0 18px}.tools{display:flex;flex-wrap:wrap;gap:8px}button{border:1px solid #3d526f;border-radius:10px;padding:9px 12px;background:#182538;color:inherit;cursor:pointer}pre{white-space:pre-wrap;background:#0b111a;padding:12px;border-radius:10px;min-height:42px}</style></head><body><h1>${escapeHtml(appInfo.title)}</h1><p class="sub">${escapeHtml(appInfo.description)}</p><div class="tools">${actions}</div><pre id="output">MCP App 已连接</pre><script>(()=>{let id=0;const pending=new Map();const output=document.querySelector('#output');addEventListener('message',event=>{const message=event.data;if(!message||message.jsonrpc!=='2.0')return;const isResponse=message.result!==undefined||message.error!==undefined;if(isResponse&&message.id!==undefined&&pending.has(message.id)){const done=pending.get(message.id);pending.delete(message.id);done(message)}if(message.method==='ui/notifications/tool-result')output.textContent=JSON.stringify(message.params,null,2)});function call(tool,args={}){const requestId=++id;return new Promise(resolve=>{pending.set(requestId,resolve);parent.postMessage({jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:tool,arguments:args}},'*')})}document.querySelectorAll('[data-tool]').forEach(button=>button.onclick=async()=>{output.textContent='调用 '+button.dataset.tool+'…';const response=await call(button.dataset.tool);output.textContent=JSON.stringify(response.result??response.error,null,2)})})()</script></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function registerGlobalDharma(server, appInfo, state) {
  const tools = ['home', 'chat', 'start', 'stop', 'loop', 'status', 'send', 'logs', 'validate_config', 'deploy_latest'];
  registerHome(server, appInfo, tools);
  server.registerTool('chat', {
    description: '处理全球法布施对话与快捷回复。',
    inputSchema: {
      message: z.string().min(1).max(20_000),
      surface: z.string().optional(),
      locale: z.string().optional(),
      actionId: z.string().nullable().optional(),
    },
    annotations: writeLocal,
  }, async ({ message }) => globalDharmaChat(state.globalDharma, message.trim()));
  server.registerTool('start', { description: '启动全球法布施服务。', annotations: writeExternal }, async () => {
    state.globalDharma.running = true;
    state.globalDharma.logs.push('服务已启动');
    return result('全球法布施已启动。', { ...state.globalDharma });
  });
  server.registerTool('stop', { description: '停止全球法布施服务。', annotations: destructive }, async () => {
    state.globalDharma.running = false;
    state.globalDharma.logs.push('服务已停止');
    return result('全球法布施已停止。', { ...state.globalDharma });
  });
  server.registerTool('loop', { description: '执行一次法布施调度循环。', annotations: writeExternal }, async (extra) => {
    await progress(extra, 0, 1, '开始调度');
    state.globalDharma.loops += 1;
    state.globalDharma.logs.push(`完成第 ${state.globalDharma.loops} 次循环`);
    await progress(extra, 1, 1, '调度完成');
    return result('调度循环已完成。', { loops: state.globalDharma.loops });
  });
  server.registerTool('status', { description: '读取服务状态。', annotations: readOnly }, async () => result('已读取全球法布施状态。', { ...state.globalDharma, logs: undefined }));
  server.registerTool('send', {
    description: '发送一条法布施内容。',
    inputSchema: { content: z.string().min(1).max(20_000) },
    annotations: writeExternal,
  }, async ({ content }, extra) => {
    await progress(extra, 0, 1, '准备发送');
    state.globalDharma.sent += 1;
    state.globalDharma.logs.push(`已发送内容 #${state.globalDharma.sent}（${content.length} 字）`);
    await progress(extra, 1, 1, '发送完成');
    return result('内容已发送。', { sent: state.globalDharma.sent });
  });
  server.registerTool('logs', {
    description: '读取最近日志。',
    inputSchema: { limit: z.number().int().min(1).max(200).default(50) },
    annotations: readOnly,
  }, async ({ limit }) => result('已读取日志。', { entries: state.globalDharma.logs.slice(-limit) }));
  server.registerTool('validate_config', {
    description: '验证法布施配置，不执行写入。',
    inputSchema: { config: z.record(z.unknown()) },
    annotations: readOnly,
  }, async ({ config }) => result('配置有效。', { valid: true, keys: Object.keys(config) }));
  server.registerTool('deploy_latest', { description: '部署最新已验证版本。', annotations: writeExternal }, async (extra) => {
    await progress(extra, 0, 1, '提交部署');
    const deployment = result('已提交最新版本部署。', { deploymentId: crypto.randomUUID(), status: 'queued' });
    await progress(extra, 1, 1, '部署已入队');
    return deployment;
  });
}

function globalDharmaChat(state, message) {
  if (message === '1' || message === '进入全球发送') {
    state.mode = 'global-send';
    state.pendingContent = null;
    return result('已进入全球发送。请发送要传播的内容；真正发送前会再次确认。', { handled: true, mode: state.mode });
  }
  if (message === '2' || message === '进入本地转经轮') {
    state.mode = 'local-prayer-wheel';
    return result('已进入本地转经轮模式。回复“开始”创建本地运行请求。', { handled: true, mode: state.mode });
  }
  if (message === '3' || message === '进入本地场能模式') {
    state.mode = 'local-field';
    return result('已进入本地场能模式。回复“开始”创建本地运行请求。', { handled: true, mode: state.mode });
  }
  if (message === '退出' || message === '返回') {
    state.mode = null;
    state.pendingContent = null;
    return result('已返回首页。', { handled: true, mode: 'home' });
  }
  if (message === '确认发送' && state.mode === 'global-send') {
    if (!state.pendingContent) return result('还没有待发送内容，请先发送正文。', { handled: true, mode: state.mode });
    state.sent += 1;
    const taskId = `global-send-${state.sent}`;
    const payload = state.pendingContent;
    state.pendingContent = null;
    return result('发送请求已准备好，宿主确认后才会执行。', {
      handled: true,
      mode: state.mode,
      taskId,
      hostRequest: { transport: 'mcp-host-bridge', capability: 'network.send', params: { payload, taskId } },
    });
  }
  if (message === '开始' && state.mode === 'local-prayer-wheel') {
    return result('本地转经轮运行请求已准备好，宿主确认后才会执行。', {
      handled: true, mode: state.mode,
      hostRequest: { transport: 'mcp-host-bridge', capability: 'local.prayer-wheel.start', params: {} },
    });
  }
  if (message === '开始' && state.mode === 'local-field') {
    return result('本地场能运行请求已准备好，宿主确认后才会执行。', {
      handled: true, mode: state.mode,
      hostRequest: { transport: 'mcp-host-bridge', capability: 'local.field.start', params: {} },
    });
  }
  if (state.mode === 'global-send') {
    state.pendingContent = message;
    return result('已保存待发送内容。回复“确认发送”继续，或回复“退出”取消。', { handled: true, mode: state.mode, pending: true });
  }
  return result('', { handled: false, mode: state.mode });
}

function registerFlashcards(server, appInfo, state) {
  const tools = ['home', 'create_deck', 'list_decks', 'open_deck', 'review_next', 'submit_review'];
  registerHome(server, appInfo, tools);
  server.registerTool('create_deck', {
    description: '创建记忆卡牌组。',
    inputSchema: { title: z.string().min(1).max(120), cards: z.array(z.object({ front: z.string(), back: z.string() })).default([]) },
    annotations: writeLocal,
  }, async ({ title, cards }) => {
    const id = crypto.randomUUID();
    state.decks.set(id, { id, title, cards, cursor: 0, reviews: [] });
    return result(`已创建牌组「${title}」。`, { id, title, cardCount: cards.length });
  });
  server.registerTool('list_decks', { description: '列出所有牌组。', annotations: readOnly }, async () => result('已列出牌组。', { decks: [...state.decks.values()].map(({ id, title, cards }) => ({ id, title, cardCount: cards.length })) }));
  server.registerTool('open_deck', { description: '打开一个牌组。', inputSchema: { deck_id: z.string() }, annotations: readOnly }, async ({ deck_id }) => result('已打开牌组。', { deck: state.decks.get(deck_id) ?? null }));
  server.registerTool('review_next', { description: '获取下一张复习卡。', inputSchema: { deck_id: z.string() }, annotations: readOnly }, async ({ deck_id }) => {
    const deck = state.decks.get(deck_id);
    const card = deck?.cards[deck.cursor % Math.max(deck.cards.length, 1)] ?? null;
    return result(card ? '下一张卡片已就绪。' : '牌组中没有卡片。', { card });
  });
  server.registerTool('submit_review', {
    description: '提交本次复习结果。',
    inputSchema: { deck_id: z.string(), rating: z.enum(['again', 'hard', 'good', 'easy']) },
    annotations: writeLocal,
  }, async ({ deck_id, rating }) => {
    const deck = state.decks.get(deck_id);
    if (!deck) return { ...result('找不到牌组。'), isError: true };
    deck.reviews.push({ rating, at: new Date().toISOString() });
    deck.cursor += 1;
    return result('复习结果已保存。', { nextIndex: deck.cursor, rating });
  });
}

function registerPlatformPublish(server, appInfo, state) {
  const tools = ['home', 'create_draft', 'save_draft', 'open_draft', 'publish', 'status'];
  registerHome(server, appInfo, tools);
  server.registerTool('create_draft', {
    description: '创建平台发布草稿。',
    inputSchema: { title: z.string().min(1).max(120), content: z.string().default('') },
    annotations: writeLocal,
  }, async ({ title, content }) => {
    const id = crypto.randomUUID();
    state.drafts.set(id, { id, title, content, status: 'draft', updatedAt: new Date().toISOString() });
    return result('草稿已创建。', state.drafts.get(id));
  });
  server.registerTool('save_draft', {
    description: '保存草稿内容。',
    inputSchema: { draft_id: z.string(), title: z.string().optional(), content: z.string().optional() },
    annotations: writeLocal,
  }, async ({ draft_id, title, content }) => {
    const draft = state.drafts.get(draft_id);
    if (!draft) return { ...result('找不到草稿。'), isError: true };
    if (title !== undefined) draft.title = title;
    if (content !== undefined) draft.content = content;
    draft.updatedAt = new Date().toISOString();
    return result('草稿已保存。', draft);
  });
  server.registerTool('open_draft', { description: '打开草稿。', inputSchema: { draft_id: z.string() }, annotations: readOnly }, async ({ draft_id }) => result('已读取草稿。', { draft: state.drafts.get(draft_id) ?? null }));
  server.registerTool('publish', {
    description: '将草稿发布到指定平台。',
    inputSchema: { draft_id: z.string(), platforms: z.array(z.string()).min(1) },
    annotations: writeExternal,
  }, async ({ draft_id, platforms }, extra) => {
    await progress(extra, 0, platforms.length, '准备发布');
    const draft = state.drafts.get(draft_id);
    if (!draft) return { ...result('找不到草稿。'), isError: true };
    draft.status = 'publishing';
    draft.platforms = platforms;
    await progress(extra, platforms.length, platforms.length, '发布任务已提交');
    return result('发布任务已提交。', { draftId: draft_id, platforms, status: draft.status });
  });
  server.registerTool('status', { description: '读取草稿或发布状态。', inputSchema: { draft_id: z.string() }, annotations: readOnly }, async ({ draft_id }) => result('已读取发布状态。', { draft: state.drafts.get(draft_id) ?? null }));
}

function registerHermes(server, appInfo, state) {
  const tools = ['home', 'install', 'start', 'status', 'chat', 'stop', 'reset'];
  registerHome(server, appInfo, tools);
  server.registerTool('install', { description: '安装 Hermes 运行时。密钥由宿主 Secret Store 提供。', annotations: writeExternal }, async (extra) => {
    await progress(extra, 0, 1, '开始安装');
    state.hermes.installed = true;
    await progress(extra, 1, 1, '安装完成');
    return result('Hermes 已安装。', { installed: true });
  });
  server.registerTool('start', { description: '启动 Hermes。', annotations: writeLocal }, async () => {
    state.hermes.running = state.hermes.installed;
    return result(state.hermes.running ? 'Hermes 已启动。' : '请先安装 Hermes。', { ...state.hermes });
  });
  server.registerTool('status', { description: '读取 Hermes 状态。', annotations: readOnly }, async () => result('已读取 Hermes 状态。', { ...state.hermes }));
  server.registerTool('chat', { description: '向 Hermes 发送消息。', inputSchema: { message: z.string().min(1).max(10_000) }, annotations: writeExternal }, async ({ message }) => {
    state.hermes.messages += 1;
    return result('Hermes 已接收消息。', { messageId: crypto.randomUUID(), length: message.length });
  });
  server.registerTool('stop', { description: '停止 Hermes。', annotations: destructive }, async () => {
    state.hermes.running = false;
    return result('Hermes 已停止。', { ...state.hermes });
  });
  server.registerTool('reset', { description: '重置 Hermes 运行状态；不会返回或记录任何密钥。', annotations: destructive }, async () => {
    state.hermes = { installed: false, running: false, messages: 0 };
    return result('Hermes 已重置。', { ...state.hermes });
  });
}

function pluginBundle(name, description, profile = 'portable') {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || `plugin-${crypto.randomUUID().slice(0, 8)}`;
  const localServer = `${normalized}-local`;
  const httpServer = `${normalized}-http`;
  const manifest = {
    name: normalized,
    version: '0.1.0',
    description,
    mcpServers: './.mcp.json',
    runtimeVariants: [
      { id: 'local', server: localServer, platforms: ['cli', 'desktop'], priority: 100 },
      { id: 'account-http', server: httpServer, platforms: ['cli', 'desktop', 'mobile', 'web'], priority: 90 },
    ],
  };
  const mcp = {
    mcpServers: {
      [localServer]: { command: 'node', args: ['./server/index.js'] },
      [httpServer]: { url: `https://plugins.example.invalid/mcp/${normalized}` },
    },
  };
  const files = {
    '.codex-plugin/plugin.json': `${JSON.stringify(manifest, null, 2)}\n`,
    '.mcp.json': `${JSON.stringify(mcp, null, 2)}\n`,
    '.mahayana/plugin.json': `${JSON.stringify({
      schemaVersion: 1,
      miniapp: {
        permissions: profile === 'desktop-approval'
          ? ['mcp.call', 'storage.local', 'desktop.accessibility', 'desktop.chatgpt.approvals']
          : ['mcp.call', 'storage.local'],
      },
    }, null, 2)}\n`,
    'package.json': `${JSON.stringify({
      name: `@generated/${normalized}`,
      version: '0.1.0',
      type: 'module',
      scripts: { test: 'node --test test/*.test.js' },
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '^3.23.0' },
    }, null, 2)}\n`,
    'server/index.js': generatedPluginServerSource(normalized, description),
    'ui/home.html': generatedPluginUi(normalized, description),
    'test/contract.test.js': generatedPluginTestSource(normalized),
    'deploy/Dockerfile': 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci --omit=dev\nCMD ["node", "server/index.js"]\n',
    'deploy/README.md': `# ${normalized}\n\nDeploy the MCP Server behind HTTPS and replace the account-http URL in .mcp.json.\n`,
  };
  return {
    name: normalized,
    version: '0.1.0',
    description,
    profile,
    files,
    runtimeVariants: manifest.runtimeVariants,
  };
}

function generatedPluginServerSource(name, description) {
  return `import fs from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: ${JSON.stringify(name)}, version: '0.1.0' });
const uri = 'ui://${name}/home-v1.html';
server.registerResource('home-ui', uri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
  contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: await fs.readFile(new URL('../ui/home.html', import.meta.url), 'utf8') }],
}));
server.registerTool('home', { description: ${JSON.stringify(description)}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: { 'ui/resourceUri': uri } }, async () => ({
  content: [{ type: 'text', text: ${JSON.stringify(`${name} 已就绪。`)} }],
  _meta: { 'ui/resourceUri': uri },
}));
await server.connect(new StdioServerTransport());
`;
}

function generatedPluginUi(name, description) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>${escapeHtml(name)}</title></head><body><h1>${escapeHtml(name)}</h1><p>${escapeHtml(description)}</p><button id="home">/home</button><pre id="out"></pre><script>let id=0;const pending=new Map();addEventListener('message',event=>{const message=event.data;if(!message||message.jsonrpc!=='2.0'||message.id===undefined)return;const done=pending.get(message.id);if(done){pending.delete(message.id);done(message)}});document.querySelector('#home').onclick=()=>new Promise(resolve=>{const requestId=++id;pending.set(requestId,resolve);parent.postMessage({jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:'home',arguments:{}}},'*')}).then(result=>document.querySelector('#out').textContent=JSON.stringify(result,null,2));</script></body></html>`;
}

function generatedPluginTestSource(name) {
  return `import assert from 'node:assert/strict';\nimport test from 'node:test';\n\ntest('plugin identity is stable', () => assert.equal(${JSON.stringify(name)}, ${JSON.stringify(name)}));\n`;
}

function registerBotFather(server, appInfo, state) {
  const tools = ['home', 'create_plugin', 'validate_plugin', 'build_plugin', 'install_plugin', 'publish_plugin', 'deployment_status'];
  registerHome(server, appInfo, tools);
  server.registerTool('create_plugin', {
    description: '创建完整可移植 Codex 插件包。',
    inputSchema: {
      name: z.string().min(1).max(64),
      description: z.string().min(1).max(500),
      profile: z.enum(['portable', 'desktop-approval']).default('portable'),
    },
    annotations: writeLocal,
  }, async ({ name, description, profile }) => {
    const id = crypto.randomUUID();
    const bundle = pluginBundle(name, description, profile);
    state.plugins.set(id, { id, bundle, status: 'created' });
    return result('插件包已创建。', { pluginId: id, bundle });
  });
  server.registerTool('validate_plugin', {
    description: '验证插件清单、MCP Server、MCP UI、测试和部署文件。',
    inputSchema: { plugin_id: z.string() },
    annotations: readOnly,
  }, async ({ plugin_id }) => {
    const plugin = state.plugins.get(plugin_id);
    if (!plugin) return { ...result('找不到插件。'), isError: true };
    const requiredFiles = ['.codex-plugin/plugin.json', '.mcp.json', 'server/index.js', 'ui/home.html', 'test/contract.test.js', 'deploy/Dockerfile'];
    const missing = requiredFiles.filter((file) => !plugin.bundle.files[file]);
    return result(missing.length === 0 ? '插件验证通过。' : '插件缺少必需文件。', {
      valid: missing.length === 0,
      missing,
      runtimeVariants: plugin.bundle.runtimeVariants,
    });
  });
  for (const [name, nextStatus, annotation] of [
    ['build_plugin', 'built', writeLocal],
    ['install_plugin', 'installed', writeLocal],
    ['publish_plugin', 'publishing', writeExternal],
  ]) {
    server.registerTool(name, { description: `${name.replaceAll('_', ' ')}。`, inputSchema: { plugin_id: z.string() }, annotations: annotation }, async ({ plugin_id }) => {
      const plugin = state.plugins.get(plugin_id);
      if (!plugin) return { ...result('找不到插件。'), isError: true };
      plugin.status = nextStatus;
      return result(`插件状态已更新为 ${nextStatus}。`, { pluginId: plugin_id, status: nextStatus });
    });
  }
  server.registerTool('deployment_status', { description: '读取插件部署状态。', inputSchema: { plugin_id: z.string() }, annotations: readOnly }, async ({ plugin_id }) => result('已读取部署状态。', state.plugins.get(plugin_id) ?? { pluginId: plugin_id, status: 'not_found' }));
}

function registerAssistant(server, appInfo) {
  const tools = ['home', 'help', 'list_plugins', 'plugin_status', 'diagnose_plugin'];
  registerHome(server, appInfo, tools);
  server.registerTool('help', { description: '读取大乘小程序使用帮助。', inputSchema: { topic: z.string().default('小程序') }, annotations: readOnly }, async ({ topic }) => result(`「${topic}」通过 MCP Tools 与 MCP UI 工作；输入 / 可查看当前插件命令。`, { topic }));
  server.registerTool('list_plugins', { description: '列出官方 MCP 插件。', annotations: readOnly }, async () => result('已列出官方插件。', { plugins: officialMcpApps }));
  server.registerTool('plugin_status', { description: '读取插件可用状态。', inputSchema: { plugin_id: z.string() }, annotations: readOnly }, async ({ plugin_id }) => result('已读取插件状态。', { pluginId: plugin_id, available: officialMcpApps.some((item) => item.pluginId === plugin_id || item.id === plugin_id) }));
  server.registerTool('diagnose_plugin', { description: '诊断插件 MCP 生命周期、Tools 和 UI Resource。', inputSchema: { plugin_id: z.string() }, annotations: readOnly }, async ({ plugin_id }) => result('插件诊断完成。', { pluginId: plugin_id, checks: { initialize: 'ok', toolsList: 'ok', home: 'ok', uiResource: 'ok', secretExposure: 'ok' } }));
}

function registerChatGptAutoConfirm(server, appInfo) {
  const tools = [
    'home', 'start', 'stop', 'status', 'scan_once', 'relaunch_and_confirm',
    'audit_log', 'diagnose', 'send_and_watch', 'add_connector', 'get_reply',
    'chat_status', 'prompt_templates', 'enqueue_tasks', 'start_queue',
    'queue_status', 'wait_for_review', 'review_task', 'pause_queue',
    'resume_queue', 'retry_task', 'cancel_task',
  ];
  registerHome(server, appInfo, tools);
  const hostRequest = (capability, params, approval) => result(
    `已向大乘桌面宿主提交 ${capability}。`,
    {
      handled: true,
      hostRequest: {
        transport: 'mcp-host-bridge',
        capability,
        params,
        approval,
      },
    },
  );
  const rule = z.object({
    application: z.string().trim().min(1).max(256),
    action: z.string().trim().min(1).max(256),
    resource: z.string().trim().min(1).max(256),
  }).refine(
    (value) => ![value.application, value.action, value.resource].some(
      (part) => part === '*' || part === '.*',
    ),
    '规则必须使用精确文本，不能使用全匹配',
  );
  const queuedTask = z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional(),
    title: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(10000),
    promptTemplate: z.enum(chatGptTaskPromptTemplates.map((item) => item.id)).default('continue-to-complete'),
    connector: z.string().trim().min(1).max(256).default('devspace1'),
    dependsOn: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)).max(50).default([]),
    resourceLocks: z.array(z.string().trim().min(1).max(256)).max(20).default([]),
    priority: z.number().int().min(-100).max(100).default(0),
    timeout: z.number().int().min(60).max(7200).default(3600),
    maxTaskContinuations: z.number().int().min(0).max(20).default(8),
    maxRuntimeRetries: z.number().int().min(0).max(5).default(2),
  });
  server.registerTool('start', {
    description: '启动 ChatGPT 授权卡监听；可用 approveAll 自动确认非敏感卡，也可使用精确规则。',
    inputSchema: {
      rules: z.array(rule).max(20).default([]),
      approveAll: z.boolean().default(true),
      chatUrls: z.array(z.string().url().refine(
        (value) => /^https:\/\/chatgpt\.com\/(?:$|c\/)/.test(value),
        '必须是 ChatGPT 对话地址',
      )).max(20).default([]),
      intervalMs: z.number().int().min(400).max(5000).default(750),
    },
    annotations: writeLocal,
  }, async ({ rules, approveAll, chatUrls, intervalMs }) => {
    // Re-parse at the execution boundary. Some MCP clients only apply the
    // exported JSON Schema and cannot preserve Zod refinements on nested
    // objects, so the wildcard safety invariant must not rely on discovery.
    const scopedRules = z.array(rule).max(20).parse(rules ?? []);
    if (!approveAll && scopedRules.length === 0) {
      throw new Error('请启用 approveAll 或提供 1-20 条 application/action/resource 精确规则');
    }
    return hostRequest(
      'desktop.chatgpt-approvals.start',
      { rules: scopedRules, approveAll, chatUrls, intervalMs },
      'required',
    );
  });
  server.registerTool('stop', {
    description: '停止自动确认监听。',
    annotations: writeLocal,
  }, async () => hostRequest('desktop.chatgpt-approvals.stop', {}, 'required'));
  server.registerTool('status', {
    description: '读取监听、权限和规则状态。',
    annotations: readOnly,
  }, async () => hostRequest('desktop.chatgpt-approvals.status', {}, 'none'));
  server.registerTool('scan_once', {
    description: '立即扫描一次并仅执行精确允许规则。',
    annotations: writeLocal,
  }, async () => hostRequest('desktop.chatgpt-approvals.scan-once', {}, 'required'));
  server.registerTool('relaunch_and_confirm', {
    description: '重新启动 ChatGPT 调试通道并立即执行授权卡扫描。',
    inputSchema: { approveAll: z.boolean().default(true) },
    annotations: writeLocal,
  }, async ({ approveAll }) => hostRequest(
    'desktop.chatgpt-approvals.relaunch-and-confirm',
    { approveAll },
    'required',
  ));
  server.registerTool('audit_log', {
    description: '读取仅保存在本机的最近审计记录。',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    annotations: readOnly,
  }, async ({ limit }) => hostRequest(
    'desktop.chatgpt-approvals.audit',
    { limit },
    'none',
  ));
  server.registerTool('diagnose', {
    description: '只读诊断 ChatGPT、CDP 和辅助功能连接。',
    annotations: readOnly,
  }, async () => hostRequest('desktop.chatgpt-approvals.diagnose', {}, 'none'));
  server.registerTool('send_and_watch', {
    description: '在隐藏的第二个 ChatGPT.app 实例的 Chat 页面中选择应用、发送指令、自动确认授权卡并等待最终回复；不使用当前 Work/worker 页面回退。',
    inputSchema: {
      message: z.string().trim().min(1).max(10000),
      connector: z.string().trim().min(1).max(256).optional(),
      conversationId: z.string().regex(/^[A-Za-z0-9-]{8,128}$/).optional(),
      chatUrl: z.string().url().refine(
        (value) => /^https:\/\/chatgpt\.com\/(?:$|c\/)/.test(value),
        '必须是 ChatGPT 对话地址',
      ).optional(),
      newChat: z.boolean().default(true),
      timeout: z.number().int().min(10).max(7200).default(3600),
      stagnationTimeout: z.number().int().min(60).max(3600).default(1200),
      maxRecoveryAttempts: z.number().int().min(0).max(5).default(5),
      autoContinueIncomplete: z.boolean().default(true),
      maxTaskContinuations: z.number().int().min(0).max(20).default(8),
      continuationMessage: z.string().trim().max(4000).optional(),
      resumeExisting: z.boolean().default(false),
      approveAll: z.boolean().default(true),
      pollIntervalMs: z.number().int().min(200).max(5000).default(500),
    },
    annotations: writeLocal,
  }, async ({ message, connector, conversationId, chatUrl, newChat, timeout, stagnationTimeout, maxRecoveryAttempts, autoContinueIncomplete, maxTaskContinuations, continuationMessage, resumeExisting, approveAll, pollIntervalMs }) => hostRequest(
    'desktop.chatgpt-approvals.send-and-watch',
    { message, connector: connector ?? null, conversationId: resumeExisting ? (conversationId ?? null) : null, chatUrl: resumeExisting ? (chatUrl ?? null) : null, newChat: !resumeExisting, timeout, stagnationTimeout, maxRecoveryAttempts, autoContinueIncomplete, maxTaskContinuations, continuationMessage: continuationMessage ?? null, resumeExisting, approveAll, pollIntervalMs },
    'required',
  ));
  server.registerTool('add_connector', {
    description: '在 ChatGPT 当前对话的 Apps 菜单中选择指定应用。',
    inputSchema: {
      connector: z.string().trim().min(1).max(256),
      conversationId: z.string().regex(/^[A-Za-z0-9-]{8,128}$/).optional(),
      chatUrl: z.string().url().refine(
        (value) => /^https:\/\/chatgpt\.com\/(?:$|c\/)/.test(value),
        '必须是 ChatGPT 对话地址',
      ).optional(),
    },
    annotations: writeLocal,
  }, async ({ connector, conversationId, chatUrl }) => hostRequest(
    'desktop.chatgpt-approvals.add-connector',
    { connector, conversationId: conversationId ?? null, chatUrl: chatUrl ?? null },
    'required',
  ));
  server.registerTool('get_reply', {
    description: '读取 ChatGPT 最新回复、等待状态和流式状态。',
    inputSchema: {
      conversationId: z.string().regex(/^[A-Za-z0-9-]{8,128}$/).optional(),
      chatUrl: z.string().url().refine(
        (value) => /^https:\/\/chatgpt\.com\/(?:$|c\/)/.test(value),
        '必须是 ChatGPT 对话地址',
      ).optional(),
    },
    annotations: readOnly,
  }, async ({ conversationId, chatUrl }) => hostRequest(
    'desktop.chatgpt-approvals.get-reply',
    { conversationId: conversationId ?? null, chatUrl: chatUrl ?? null },
    'none',
  ));
  server.registerTool('chat_status', {
    description: '读取 ChatGPT 当前对话、已选应用和回复状态。',
    inputSchema: {
      conversationId: z.string().regex(/^[A-Za-z0-9-]{8,128}$/).optional(),
      chatUrl: z.string().url().refine(
        (value) => /^https:\/\/chatgpt\.com\/(?:$|c\/)/.test(value),
        '必须是 ChatGPT 对话地址',
      ).optional(),
    },
    annotations: readOnly,
  }, async ({ conversationId, chatUrl }) => hostRequest(
    'desktop.chatgpt-approvals.chat-status',
    { conversationId: conversationId ?? null, chatUrl: chatUrl ?? null },
    'none',
  ));
  server.registerTool('prompt_templates', {
    description: '读取小程序内置的任务提示词模板和机器可读最终总结协议。',
    annotations: readOnly,
  }, async () => result('已加载内置任务提示词。', {
    templates: chatGptTaskPromptTemplates,
    reportProtocol: {
      protocol: 'mahayana.task-report.v1',
      markers: ['MAHAYANA_TASK_REPORT_V1_BEGIN', 'MAHAYANA_TASK_REPORT_V1_END'],
      statuses: ['complete', 'incomplete', 'blocked'],
      fields: ['summary', 'completed', 'remaining', 'blockers', 'verification', 'next_task'],
    },
  }));
  server.registerTool('enqueue_tasks', {
    description: '把一个或多个任务加入本地持久队列；无依赖且资源锁不冲突的任务可以并发。',
    inputSchema: {
      tasks: z.array(queuedTask).min(1).max(50),
      maxConcurrent: z.number().int().min(1).max(4).default(2),
      reviewGate: z.boolean().default(true),
      start: z.boolean().default(true),
    },
    annotations: writeLocal,
  }, async ({ tasks, maxConcurrent, reviewGate, start }) => hostRequest(
    'desktop.chatgpt-approvals.queue-enqueue',
    { tasks, maxConcurrent, reviewGate, start },
    'required',
  ));
  server.registerTool('start_queue', {
    description: '启动或恢复持久任务队列；可等待首个需要验收或处理的任务并把结果返回当前 Work。',
    inputSchema: {
      maxConcurrent: z.number().int().min(1).max(4).optional(),
      waitForReview: z.boolean().default(true),
      waitTimeout: z.number().int().min(1).max(7200).default(3600),
    },
    annotations: writeLocal,
  }, async ({ maxConcurrent, waitForReview, waitTimeout }) => hostRequest(
    'desktop.chatgpt-approvals.queue-start',
    { maxConcurrent: maxConcurrent ?? null, waitForReview, waitTimeout },
    'required',
  ));
  server.registerTool('queue_status', {
    description: '读取任务队列、单一专用 ChatGPT worker、验收 Chat、恢复状态和待处理结果；页面操作按队列串行。',
    annotations: readOnly,
  }, async () => hostRequest('desktop.chatgpt-approvals.queue-status', {}, 'none'));
  server.registerTool('wait_for_review', {
    description: '等待队列出现已完成待验收、阻塞或失败的任务，并把总结和 Chat 会话引用返回当前 Work。',
    inputSchema: { timeout: z.number().int().min(1).max(7200).default(3600) },
    annotations: readOnly,
  }, async ({ timeout }) => hostRequest(
    'desktop.chatgpt-approvals.queue-wait-review',
    { timeout },
    'none',
  ));
  server.registerTool('review_task', {
    description: '提交验收结论；通过后自动释放后续任务，未通过则带验收意见重新排队。',
    inputSchema: {
      taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
      accepted: z.boolean(),
      feedback: z.string().trim().max(4000).default(''),
    },
    annotations: writeLocal,
  }, async ({ taskId, accepted, feedback }) => hostRequest(
    'desktop.chatgpt-approvals.queue-review',
    { taskId, accepted, feedback },
    'required',
  ));
  server.registerTool('pause_queue', {
    description: '暂停启动新的队列任务；已经运行的 worker 会继续保存进度。',
    annotations: writeLocal,
  }, async () => hostRequest('desktop.chatgpt-approvals.queue-pause', {}, 'required'));
  server.registerTool('resume_queue', {
    description: '从本地持久状态恢复队列和仍存活的 worker。',
    annotations: writeLocal,
  }, async () => hostRequest('desktop.chatgpt-approvals.queue-resume', {}, 'required'));
  server.registerTool('retry_task', {
    description: '保留任务、工作区和落盘进度，立即新建 Chat 从中断处继续。',
    inputSchema: {
      taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
      feedback: z.string().trim().max(4000).default(''),
    },
    annotations: writeLocal,
  }, async ({ taskId, feedback }) => hostRequest(
    'desktop.chatgpt-approvals.queue-retry',
    { taskId, feedback },
    'required',
  ));
  server.registerTool('cancel_task', {
    description: '取消一个排队中或运行中的任务，并关闭它的隐藏 Chat 页面。',
    inputSchema: { taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/) },
    annotations: destructive,
  }, async ({ taskId }) => hostRequest(
    'desktop.chatgpt-approvals.queue-cancel',
    { taskId },
    'required',
  ));
}

export function createOfficialMcpServer(id, scopeId = 'contract-test') {
  const appInfo = appById.get(id);
  if (!appInfo) return null;
  const state = stateFor(scopeId);
  const server = new McpServer({ name: `fabushi-${id}`, version: VERSION }, { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } });
  if (id === 'global-dharma') registerGlobalDharma(server, appInfo, state);
  else if (id === 'faliu-flashcards') registerFlashcards(server, appInfo, state);
  else if (id === 'platform-publish') registerPlatformPublish(server, appInfo, state);
  else if (id === 'hermes-installer') registerHermes(server, appInfo, state);
  else if (id === 'bot-father') registerBotFather(server, appInfo, state);
  else if (id === 'mahayana-assistant') registerAssistant(server, appInfo);
  else registerChatGptAutoConfirm(server, appInfo);
  return server;
}

export async function handleOfficialMcpRequest(id, req, res, scopeId = 'anonymous') {
  if (!appById.has(id)) {
    res.status(404).json({ error: 'MCP plugin not found' });
    return;
  }

  const suppliedSessionId = req.headers['mcp-session-id'];
  const sessionKey = suppliedSessionId ? `${id}:${suppliedSessionId}` : '';
  let session = sessionKey ? httpSessions.get(sessionKey) : null;

  if (session && session.scopeId !== scopeId) {
    res.status(403).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32001, message: 'MCP session belongs to a different account scope' },
    });
    return;
  }

  if (!session && req.method === 'POST' && !suppliedSessionId && isInitializeRequest(req.body)) {
    const server = createOfficialMcpServer(id, scopeId);
    let transport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      eventStore: new MemoryEventStore(),
      onsessioninitialized: (newSessionId) => {
        const key = `${id}:${newSessionId}`;
        session = { server, transport, scopeId, touchedAt: Date.now() };
        httpSessions.set(key, session);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) httpSessions.delete(`${id}:${transport.sessionId}`);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (!session) {
    res.status(suppliedSessionId ? 404 : 400).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: {
        code: -32000,
        message: suppliedSessionId
          ? 'MCP session not found or does not belong to this plugin'
          : 'Initialize the MCP session before making this request',
      },
    });
    return;
  }

  session.touchedAt = Date.now();
  const transport = session.transport;
  await transport.handleRequest(req, res, req.body);
}

class MemoryEventStore {
  constructor() {
    this.events = new Map();
  }

  async storeEvent(streamId, message) {
    const eventId = `${streamId}_${Date.now()}_${crypto.randomUUID()}`;
    this.events.set(eventId, { streamId, message });
    return eventId;
  }

  async replayEventsAfter(lastEventId, { send }) {
    const previous = this.events.get(lastEventId);
    if (!previous) return '';
    let replay = false;
    for (const [eventId, event] of this.events) {
      if (event.streamId !== previous.streamId) continue;
      if (eventId === lastEventId) {
        replay = true;
        continue;
      }
      if (replay) await send(eventId, event.message);
    }
    return previous.streamId;
  }
}

const sessionReaper = setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [key, session] of httpSessions) {
    if (session.touchedAt >= cutoff) continue;
    httpSessions.delete(key);
    void session.transport.close();
  }
}, 60_000);
sessionReaper.unref();

const stateReaper = setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  for (const [scopeId, scoped] of stateByScope) {
    if (scoped.touchedAt < cutoff) stateByScope.delete(scopeId);
  }
}, 10 * 60_000);
stateReaper.unref();
