import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pino from 'pino';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const resourcesDir = path.join(dataDir, 'resources');
const dbPath = process.env.SQLITE_PATH || path.join(dataDir, 'dacheng-ai.sqlite');

fs.mkdirSync(resourcesDir, { recursive: true });

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(helmet());
const corsOrigin =
  !process.env.CORS_ORIGIN || process.env.CORS_ORIGIN.trim() === '*'
    ? true
    : process.env.CORS_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '1mb' }));
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.RATE_LIMIT_PER_MINUTE || 90),
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
    ON conversations (user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
    ON messages (conversation_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS usage_months (
    user_id TEXT NOT NULL,
    month TEXT NOT NULL,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, month)
  );

  CREATE TABLE IF NOT EXISTS resource_downloads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const statements = {
  insertConversation: db.prepare(`
    INSERT INTO conversations (id, user_id, title, provider, model, created_at, updated_at)
    VALUES (@id, @userId, @title, @provider, @model, @createdAt, @updatedAt)
  `),
  updateConversation: db.prepare(`
    UPDATE conversations
    SET title = @title, updated_at = @updatedAt
    WHERE id = @id AND user_id = @userId
  `),
  getConversation: db.prepare(`
    SELECT * FROM conversations WHERE id = ? AND user_id = ? LIMIT 1
  `),
  listConversations: db.prepare(`
    SELECT id, title, updated_at AS updatedAt
    FROM conversations
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 30
  `),
  insertMessage: db.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, content,
      prompt_tokens, completion_tokens, total_tokens, created_at
    )
    VALUES (
      @id, @conversationId, @role, @content,
      @promptTokens, @completionTokens, @totalTokens, @createdAt
    )
  `),
  listMessages: db.prepare(`
    SELECT role, content, prompt_tokens AS promptTokens,
      completion_tokens AS completionTokens, total_tokens AS totalTokens,
      created_at AS createdAt
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `),
  getUsage: db.prepare(`
    SELECT total_tokens AS totalTokens FROM usage_months WHERE user_id = ? AND month = ?
  `),
  upsertUsage: db.prepare(`
    INSERT INTO usage_months (user_id, month, total_tokens, updated_at)
    VALUES (@userId, @month, @totalTokens, @updatedAt)
    ON CONFLICT(user_id, month)
    DO UPDATE SET total_tokens = usage_months.total_tokens + excluded.total_tokens,
      updated_at = excluded.updated_at
  `),
  insertResourceDownload: db.prepare(`
    INSERT INTO resource_downloads (
      id, user_id, title, source_name, source_url, file_name, file_path, created_at
    )
    VALUES (
      @id, @userId, @title, @sourceName, @sourceUrl, @fileName, @filePath, @createdAt
    )
  `),
};

const deepseekApiKey = process.env.DEEPSEEK_API_KEY || '';
const deepseekBaseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const cbetaApiRoot = (process.env.CBETA_API_ROOT || 'http://144.24.17.21.sslip.io:3000').replace(/\/+$/, '');
const fabushiApiBaseUrl = (process.env.FABUSHI_API_BASE_URL || 'https://api.ombhrum.com').replace(/\/+$/, '');
const memberMonthlyLimit = Number(process.env.MEMBER_MONTHLY_TOKEN_LIMIT || 1_000_000);
const freeMonthlyLimit = Number(process.env.FREE_MONTHLY_TOKEN_LIMIT || 50_000);
const maxResourceTextChars = Number(process.env.MAX_RESOURCE_TEXT_CHARS || 80_000);

const systemPrompt = [
  '你是“大乘”App 的 AI 助手。',
  '你的核心任务是帮助用户查找、整理、理解并全球法布施合法可分享的佛法资源。',
  '回答要庄重、简洁、可执行；涉及经典、仪轨或资源时，提醒用户尊重版权、来源和当地法规。',
  '如果用户想找资源，优先建议使用 + 菜单里的“查找下载资源”。',
].join('\n');

function nowIso() {
  return new Date().toISOString();
}

function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function jsonResponse(res, status, payload) {
  res.status(status).json(payload);
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function bearerToken(req) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeUserText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/\u0000/g, '').trim();
}

function estimateTokens(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 3));
}

function normalizeMembershipPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  return Boolean(
    data.isActive ||
      data.active ||
      data.hasPremiumAccess ||
      data.hasPremiumMembership ||
      data.isPremium ||
      data.status === 'active' ||
      data.type === 'paid' ||
      data.membershipType === 'paid',
  );
}

async function checkRemoteMembership(token) {
  if (!token || !fabushiApiBaseUrl) return false;
  const endpoints = [
    '/api/stripe/membership-status',
    '/api/alipay/check-membership',
    '/api/auth/user-info',
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${fabushiApiBaseUrl}${endpoint}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) continue;
      const payload = await response.json();
      if (normalizeMembershipPayload(payload)) return true;
    } catch (error) {
      logger.debug({ endpoint, error: String(error) }, 'membership lookup skipped');
    }
  }

  return false;
}

async function resolveUser(req, body = {}) {
  const token = bearerToken(req);
  const username = safeUserText(body.username || req.query.username);
  const tokenHash = token ? sha256(token).slice(0, 24) : '';
  const anonymousHash = sha256(`${req.ip}|${req.get('User-Agent') || ''}`).slice(0, 24);
  const userId = username
    ? `user:${username}`
    : tokenHash
      ? `token:${tokenHash}`
      : `anon:${anonymousHash}`;
  const remoteMember = await checkRemoteMembership(token);
  const memberHint = body.clientMembershipHint === true;
  return {
    userId,
    username,
    tokenHash,
    isMember: remoteMember || memberHint,
  };
}

function usageFor(userId) {
  const month = monthKey();
  const row = statements.getUsage.get(userId, month);
  return {
    month,
    used: Number(row?.totalTokens || 0),
  };
}

function enforceTokenBudget(user, estimatedTokensForRequest) {
  const limit = user.isMember ? memberMonthlyLimit : freeMonthlyLimit;
  const usage = usageFor(user.userId);
  if (usage.used + estimatedTokensForRequest > limit) {
    const error = new Error('本月 AI token 额度已不足');
    error.statusCode = 429;
    error.details = {
      monthlyLimit: limit,
      usedTokens: usage.used,
      remainingTokens: Math.max(0, limit - usage.used),
    };
    throw error;
  }
  return { limit, usage };
}

function recordUsage(userId, totalTokens) {
  if (!totalTokens || totalTokens < 1) return;
  statements.upsertUsage.run({
    userId,
    month: monthKey(),
    totalTokens,
    updatedAt: nowIso(),
  });
}

function titleFromMessage(message) {
  const compact = message.replace(/\s+/g, ' ').trim();
  if (!compact) return '新对话';
  return compact.length > 22 ? `${compact.slice(0, 22)}...` : compact;
}

function normalizeMessages(rows) {
  return rows.map((row) => ({
    role: row.role,
    content: row.content,
  }));
}

async function callDeepSeek(messages) {
  if (!deepseekApiKey) {
    const error = new Error('DeepSeek API key is not configured');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(`${deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: deepseekModel,
      messages,
      temperature: 0.4,
      max_tokens: 1400,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const bodyText = await response.text();
  let payload;
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    payload = { error: bodyText };
  }

  if (!response.ok) {
    const upstreamMessage = payload?.error?.message || payload?.message || '';
    const friendlyMessage =
      response.status === 402 || /insufficient\s+balance/i.test(upstreamMessage)
        ? '大乘 AI 服务额度暂不可用，请联系管理员充值 DeepSeek 账户后重试。'
        : upstreamMessage || `DeepSeek request failed: ${response.status}`;
    const error = new Error(friendlyMessage);
    error.statusCode = response.status;
    throw error;
  }

  const message = payload?.choices?.[0]?.message?.content?.trim();
  if (!message) {
    const error = new Error('DeepSeek returned an empty response');
    error.statusCode = 502;
    throw error;
  }

  return {
    message,
    usage: {
      promptTokens: Number(payload?.usage?.prompt_tokens || 0),
      completionTokens: Number(payload?.usage?.completion_tokens || 0),
      totalTokens: Number(payload?.usage?.total_tokens || 0),
    },
  };
}

app.get('/health', (_req, res) => {
  jsonResponse(res, 200, {
    status: 'ok',
    service: 'dacheng-ai-backend',
    provider: 'deepseek',
    model: deepseekModel,
    codexSdkAvailable: true,
    timestamp: nowIso(),
  });
});

app.post(
  '/api/ai/chat',
  asyncHandler(async (req, res) => {
    const message = safeUserText(req.body?.message);
    if (!message) {
      return jsonResponse(res, 400, { success: false, message: 'message is required' });
    }

    const user = await resolveUser(req, req.body || {});
    const estimated = estimateTokens(message) + 600;
    const budget = enforceTokenBudget(user, estimated);
    const createdAt = nowIso();
    const conversationId = safeUserText(req.body?.conversationId) || crypto.randomUUID();
    let conversation = statements.getConversation.get(conversationId, user.userId);
    const isNewConversation = !conversation;

    if (isNewConversation) {
      conversation = {
        id: conversationId,
        user_id: user.userId,
        title: titleFromMessage(message),
      };
      statements.insertConversation.run({
        id: conversationId,
        userId: user.userId,
        title: conversation.title,
        provider: 'deepseek',
        model: deepseekModel,
        createdAt,
        updatedAt: createdAt,
      });
    }

    statements.insertMessage.run({
      id: crypto.randomUUID(),
      conversationId,
      role: 'user',
      content: message,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      createdAt,
    });

    const historyRows = statements.listMessages.all(conversationId).slice(-14);
    const modelMessages = [
      { role: 'system', content: systemPrompt },
      ...normalizeMessages(historyRows),
    ];

    const aiResult = await callDeepSeek(modelMessages);
    const usage = {
      promptTokens: aiResult.usage.promptTokens || estimateTokens(JSON.stringify(modelMessages)),
      completionTokens: aiResult.usage.completionTokens || estimateTokens(aiResult.message),
      totalTokens:
        aiResult.usage.totalTokens ||
        estimateTokens(JSON.stringify(modelMessages)) + estimateTokens(aiResult.message),
    };
    recordUsage(user.userId, usage.totalTokens);

    const answeredAt = nowIso();
    statements.insertMessage.run({
      id: crypto.randomUUID(),
      conversationId,
      role: 'assistant',
      content: aiResult.message,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      createdAt: answeredAt,
    });
    statements.updateConversation.run({
      id: conversationId,
      userId: user.userId,
      title: isNewConversation ? titleFromMessage(message) : conversation.title,
      updatedAt: answeredAt,
    });

    const latestUsage = usageFor(user.userId);
    const monthlyLimit = budget.limit;
    jsonResponse(res, 200, {
      success: true,
      conversationId,
      provider: 'deepseek',
      model: deepseekModel,
      message: aiResult.message,
      usage: {
        ...usage,
        monthlyLimit,
        remainingTokens: Math.max(0, monthlyLimit - latestUsage.used),
      },
    });
  }),
);

app.get(
  '/api/ai/conversations',
  asyncHandler(async (req, res) => {
    const user = await resolveUser(req, { username: req.query.username });
    const items = statements.listConversations.all(user.userId).map((item) => ({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
    }));
    jsonResponse(res, 200, { success: true, items });
  }),
);

app.get(
  '/api/ai/conversations/:id',
  asyncHandler(async (req, res) => {
    const user = await resolveUser(req);
    const conversation = statements.getConversation.get(req.params.id, user.userId);
    if (!conversation) {
      return jsonResponse(res, 404, { success: false, message: 'conversation not found' });
    }
    const messages = statements.listMessages.all(req.params.id).map((item) => ({
      role: item.role,
      content: item.content,
      createdAt: item.createdAt,
    }));
    jsonResponse(res, 200, {
      success: true,
      conversation: {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updated_at,
      },
      messages,
    });
  }),
);

function buildUrl(base, endpoint, params = {}) {
  const url = new URL(endpoint, `${base}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanExtractedText(value) {
  let text = String(value || '')
    .replace(/\b[A-Z]{1,3}\d{2}n\d{4,5}[a-z]?_p?\d{4}[a-z]\d{2}\b/g, ' ')
    .replace(/\uFFFD/g, '')
    .replace(/\s+([，。；：！？、」』）》】])/g, '$1')
    .replace(/([「『《（【])\s+/g, '$1');
  for (let i = 0; i < 3; i += 1) {
    text = text.replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2');
  }
  return text.replace(/[ \t]{2,}/g, ' ').trim();
}

function compactText(value, limit = 140) {
  const text = stripHtml(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function collectSearchResults(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data?.results?.docs)) return data.results.docs;
  if (Array.isArray(data?.response?.docs)) return data.response.docs;
  if (Array.isArray(data.docs)) return data.docs;
  return [];
}

function firstText(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (Array.isArray(value)) {
      const first = value.map((entry) => safeUserText(String(entry))).find(Boolean);
      if (first) return first;
    }
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function firstNumber(item, keys, fallback = undefined) {
  for (const key of keys) {
    const value = item?.[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return fallback;
}

async function searchCbetaTitle(query, limit) {
  const url = buildUrl(cbetaApiRoot, 'search/title', { q: query, start: 0, rows: limit });
  const data = await fetchJson(url);
  return collectSearchResults(data).flatMap((item) => {
    const work = firstText(item, ['work', 'work_id', 'workId']);
    const title = firstText(item, ['content', 'title', 'work_title', 'workTitle']);
    if (!work || !title) return [];
    const juan = firstNumber(item, ['juan', 'juan_num', 'juanNum'], 1);
    return [
      {
        id: `cbeta-title-${work}-${juan}`,
        title,
        sourceName: 'CBETA 佛典',
        url: `cbeta:${work}:${juan}`,
        snippet: firstText(item, ['byline', 'creators', 'time_dynasty']) || '可下载经文正文并用于全球法布施。',
        resourceType: 'scripture',
        work,
        juan,
      },
    ];
  });
}

async function searchCbetaContent(query, limit) {
  const endpoints = ['search/fulltext', 'search/content', 'search/all_in_one'];
  const settled = await Promise.allSettled(
    endpoints.map((endpoint) =>
      fetchJson(buildUrl(cbetaApiRoot, endpoint, { q: query, start: 0, rows: limit, field: 'content' })),
    ),
  );
  const results = [];
  for (const response of settled) {
    if (response.status !== 'fulfilled') continue;
    for (const item of collectSearchResults(response.value)) {
      const work = firstText(item, ['work', 'work_id', 'workId', 'sutra', 'id']);
      const snippet = compactText(firstText(item, ['kwic', 'highlight', 'snippet', 'content', 'text', 'body', 'p']));
      if (!work || !snippet) continue;
      const juan = firstNumber(item, ['juan', 'juan_num', 'juanNum', '卷'], 1);
      const title = firstText(item, ['title', 'work_title', 'workTitle', 'sutra_name', 'book', 'name']) || work;
      results.push({
        id: `cbeta-content-${work}-${juan}-${sha256(snippet).slice(0, 8)}`,
        title,
        sourceName: 'CBETA 佛典',
        url: `cbeta:${work}:${juan}`,
        snippet,
        resourceType: 'scripture',
        work,
        juan,
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

function directUrlResource(query) {
  const url = safeUserText(query);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  return {
    id: `url-${sha256(url).slice(0, 12)}`,
    title: parsed.hostname,
    sourceName: '网页资源',
    url,
    snippet: '直接下载并提取这个链接的可读正文。',
    resourceType: 'web',
  };
}

const curatedCbetaWorks = [
  {
    work: 'T0235',
    juan: 1,
    title: '金剛般若波羅蜜經',
    keywords: ['金剛般若波羅蜜經', '金刚般若波罗蜜经', '金剛經', '金刚经'],
    snippet: '姚秦 鳩摩羅什譯。常用于读诵、共修与法布施的般若经典。',
  },
  {
    work: 'T0251',
    juan: 1,
    title: '般若波羅蜜多心經',
    keywords: ['般若波羅蜜多心經', '般若波罗蜜多心经', '心經', '心经'],
    snippet: '唐 玄奘譯。篇幅短，适合加入禅室功课本与日常持诵。',
  },
  {
    work: 'T0262',
    juan: 1,
    title: '妙法蓮華經',
    keywords: ['妙法蓮華經', '妙法莲华经', '法華經', '法华经'],
    snippet: '姚秦 鳩摩羅什譯。可按卷下载正文，用于长期功课与分享。',
  },
  {
    work: 'T0279',
    juan: 1,
    title: '大方廣佛華嚴經',
    keywords: ['大方廣佛華嚴經', '大方广佛华严经', '華嚴經', '华严经'],
    snippet: '唐 實叉難陀譯。可按卷下载正文，用于系统研读与法布施。',
  },
  {
    work: 'T0360',
    juan: 1,
    title: '佛說無量壽經',
    keywords: ['佛說無量壽經', '佛说无量寿经', '無量壽經', '无量寿经'],
    snippet: '净土经典。可下载正文，用于净土功课本与全球法布施。',
  },
  {
    work: 'T0365',
    juan: 1,
    title: '佛說觀無量壽佛經',
    keywords: ['佛說觀無量壽佛經', '佛说观无量寿佛经', '觀無量壽經', '观无量寿经'],
    snippet: '净土三经之一。适合查找下载后加入净土功课。',
  },
  {
    work: 'T0366',
    juan: 1,
    title: '佛說阿彌陀經',
    keywords: ['佛說阿彌陀經', '佛说阿弥陀经', '阿彌陀經', '阿弥陀经'],
    snippet: '姚秦 鳩摩羅什譯。篇幅适中，适合共修、持诵与分享。',
  },
  {
    work: 'T0475',
    juan: 1,
    title: '維摩詰所說經',
    keywords: ['維摩詰所說經', '维摩诘所说经', '維摩詰經', '维摩诘经'],
    snippet: '姚秦 鳩摩羅什譯。大乘经典，可按卷下载用于研读。',
  },
  {
    work: 'T0676',
    juan: 1,
    title: '解深密經',
    keywords: ['解深密經', '解深密经'],
    snippet: '唯识相关大乘经典。适合研读、整理笔记与法布施。',
  },
  {
    work: 'T1666',
    juan: 1,
    title: '大乘起信論',
    keywords: ['大乘起信論', '大乘起信论', '起信論', '起信论'],
    snippet: '大乘论典。适合下载后作为研习功课资料。',
  },
];

function localCbetaResults(query, limit) {
  const normalizedQuery = safeUserText(query).toLowerCase();
  if (!normalizedQuery) return [];
  return curatedCbetaWorks
    .filter((item) =>
      item.keywords.some((keyword) => {
        const normalizedKeyword = keyword.toLowerCase();
        return normalizedKeyword.includes(normalizedQuery) || normalizedQuery.includes(normalizedKeyword);
      }),
    )
    .slice(0, limit)
    .map((item) => ({
      id: `cbeta-curated-${item.work}-${item.juan}`,
      title: item.title,
      sourceName: 'CBETA 佛典',
      url: `cbeta:${item.work}:${item.juan}`,
      snippet: item.snippet,
      resourceType: 'scripture',
      work: item.work,
      juan: item.juan,
    }));
}

function uniqueResources(items, limit) {
  const seen = new Set();
  const results = [];
  for (const item of items) {
    const key = `${item.url}:${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item);
    if (results.length >= limit) break;
  }
  return results;
}

app.post(
  '/api/resources/search',
  asyncHandler(async (req, res) => {
    const query = safeUserText(req.body?.query);
    const limit = Math.min(Math.max(Number(req.body?.limit || 12), 1), 20);
    if (query.length < 2) {
      return jsonResponse(res, 400, { success: false, message: 'query is required' });
    }

    const direct = directUrlResource(query);
    const results = [];
    if (direct) results.push(direct);
    results.push(...localCbetaResults(query, limit));

    const [titleResults, contentResults] = await Promise.allSettled([
      searchCbetaTitle(query, limit),
      searchCbetaContent(query, limit),
    ]);
    if (titleResults.status === 'fulfilled') results.push(...titleResults.value);
    if (contentResults.status === 'fulfilled') results.push(...contentResults.value);

    jsonResponse(res, 200, {
      success: true,
      source: 'cbeta',
      items: uniqueResources(results, limit),
    });
  }),
);

function parseCbetaResource(input) {
  const work = safeUserText(input.work);
  const juan = Number(input.juan || 1);
  if (work) return { work, juan: Number.isFinite(juan) ? juan : 1 };

  const url = safeUserText(input.url);
  const match = /^cbeta:([^:]+):(\d+)$/i.exec(url);
  if (!match) return null;
  return {
    work: match[1].toUpperCase(),
    juan: Number(match[2] || 1),
  };
}

function safeFileName(value) {
  const normalized = String(value || 'dharma-resource')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return normalized || 'dharma-resource';
}

function extractCbetaHtml(data) {
  const first = Array.isArray(data?.results) ? data.results[0] : null;
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && typeof first.html === 'string') return first.html;
  if (typeof data?.html === 'string') return data.html;
  return '';
}

async function downloadCbetaResource(resource) {
  const url = buildUrl(cbetaApiRoot, 'juans', {
    work: resource.work,
    juan: resource.juan,
    work_info: 1,
    toc: 1,
  });
  const data = await fetchJson(url);
  const workInfo = data.work_info || {};
  const title = safeUserText(workInfo.title) || safeUserText(resource.title) || resource.work;
  const html = extractCbetaHtml(data);
  const text = cleanExtractedText(stripHtml(html));
  if (!text) throw new Error('CBETA resource returned empty content');
  return {
    title,
    sourceName: 'CBETA 佛典',
    url: `cbeta:${resource.work}:${resource.juan}`,
    contentText: text.slice(0, maxResourceTextChars),
    fileName: `${resource.work}_${resource.juan}_${safeFileName(title)}.txt`,
  };
}

async function downloadWebResource(input) {
  const url = safeUserText(input.url);
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https resources can be downloaded');
  }

  const response = await fetch(parsed, {
    headers: {
      Accept: 'text/html, text/plain, application/xhtml+xml, application/xml;q=0.8, */*;q=0.5',
      'User-Agent': 'DachengResourceDownloader/1.0 (+https://ombhrum.com)',
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Resource download failed: ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  const title = safeUserText(input.title) || parsed.hostname;
  const contentText = contentType.includes('html') ? cleanExtractedText(stripHtml(body)) : body.trim();
  if (!contentText) throw new Error('Resource returned empty content');
  return {
    title,
    sourceName: safeUserText(input.sourceName) || parsed.hostname,
    url,
    contentText: contentText.slice(0, maxResourceTextChars),
    fileName: `${safeFileName(title)}.txt`,
  };
}

function persistDownloadedResource(user, content) {
  const id = crypto.randomUUID();
  const fileName = `${id}-${safeFileName(content.fileName)}`;
  const filePath = path.join(resourcesDir, fileName);
  fs.writeFileSync(filePath, content.contentText, 'utf8');
  statements.insertResourceDownload.run({
    id,
    userId: user.userId,
    title: content.title,
    sourceName: content.sourceName,
    sourceUrl: content.url,
    fileName: content.fileName,
    filePath,
    createdAt: nowIso(),
  });
}

app.post(
  '/api/resources/download',
  asyncHandler(async (req, res) => {
    const user = await resolveUser(req, req.body || {});
    const cbeta = parseCbetaResource(req.body || {});
    const content = cbeta
      ? await downloadCbetaResource({ ...req.body, ...cbeta })
      : await downloadWebResource(req.body || {});
    persistDownloadedResource(user, content);
    jsonResponse(res, 200, {
      success: true,
      ...content,
    });
  }),
);

app.post(
  '/api/codex/resource-task',
  asyncHandler(async (req, res) => {
    if (process.env.ENABLE_CODEX_SDK !== 'true') {
      return jsonResponse(res, 403, {
        success: false,
        message: 'Codex SDK task runner is disabled. Set ENABLE_CODEX_SDK=true on the server to enable it.',
      });
    }
    const prompt = safeUserText(req.body?.prompt);
    if (!prompt) {
      return jsonResponse(res, 400, { success: false, message: 'prompt is required' });
    }
    const { Codex } = await import('@openai/codex-sdk');
    const codex = new Codex();
    const thread = codex.startThread();
    const result = await thread.run(prompt);
    jsonResponse(res, 200, {
      success: true,
      threadId: thread.id,
      result,
    });
  }),
);

app.use((error, _req, res, _next) => {
  const status = Number(error.statusCode || error.status || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  logger.error({ error: error.stack || String(error) }, 'request failed');
  jsonResponse(res, safeStatus, {
    success: false,
    message: error.message || 'Internal Server Error',
    details: error.details,
  });
});

const port = Number(process.env.PORT || 8788);
app.listen(port, '0.0.0.0', () => {
  logger.info(
    {
      port,
      dbPath,
      dataDir,
      deepseekModel,
      cbetaApiRoot,
    },
    'Dacheng AI backend started',
  );
});
