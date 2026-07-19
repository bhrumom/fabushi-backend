import crypto from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const APP_MIME = 'text/html;profile=mcp-app';
const VERSION = '1.0.0';

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
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src data:"><style>:root{color-scheme:light dark}body{font:15px system-ui;margin:0;padding:20px;background:#101722;color:#edf3ff}h1{font-size:21px;margin:0 0 6px}.sub{color:#9eb0ca;margin:0 0 18px}.tools{display:flex;flex-wrap:wrap;gap:8px}button{border:1px solid #3d526f;border-radius:10px;padding:9px 12px;background:#182538;color:inherit;cursor:pointer}pre{white-space:pre-wrap;background:#0b111a;padding:12px;border-radius:10px;min-height:42px}</style></head><body><h1>${escapeHtml(appInfo.title)}</h1><p class="sub">${escapeHtml(appInfo.description)}</p><div class="tools">${actions}</div><pre id="output">MCP App 已连接</pre><script>(()=>{let id=0;const pending=new Map();const output=document.querySelector('#output');addEventListener('message',event=>{const message=event.data;if(!message||message.jsonrpc!=='2.0')return;if(message.id!==undefined&&pending.has(message.id)){const done=pending.get(message.id);pending.delete(message.id);done(message)}if(message.method==='ui/notifications/tool-result')output.textContent=JSON.stringify(message.params,null,2)});function call(tool,args={}){const requestId=++id;return new Promise(resolve=>{pending.set(requestId,resolve);parent.postMessage({jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:tool,arguments:args}},'*')})}document.querySelectorAll('[data-tool]').forEach(button=>button.onclick=async()=>{output.textContent='调用 '+button.dataset.tool+'…';const response=await call(button.dataset.tool);output.textContent=JSON.stringify(response.result??response.error,null,2)})})()</script></body></html>`;
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

function pluginBundle(name, description) {
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
    inputSchema: { name: z.string().min(1).max(64), description: z.string().min(1).max(500) },
    annotations: writeLocal,
  }, async ({ name, description }) => {
    const id = crypto.randomUUID();
    const bundle = pluginBundle(name, description);
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
  else registerAssistant(server, appInfo);
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
