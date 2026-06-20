import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Database from 'better-sqlite3';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pino from 'pino';
import { z } from 'zod';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const resourcesDir = path.join(dataDir, 'resources');
const codexHomeDir = process.env.CODEX_HOME || path.join(dataDir, 'codex-home');
const codexTempDir = process.env.CODEX_TMPDIR || path.join(dataDir, 'codex-tmp');
const codexRuntimeDir = process.env.XDG_RUNTIME_DIR || path.join(dataDir, 'codex-runtime');
const dbPath = process.env.SQLITE_PATH || path.join(dataDir, 'dacheng-ai.sqlite');

fs.mkdirSync(resourcesDir, { recursive: true });
fs.mkdirSync(codexHomeDir, { recursive: true });
fs.mkdirSync(codexTempDir, { recursive: true });
fs.mkdirSync(codexRuntimeDir, { recursive: true });

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

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    openclaw_run_id TEXT,
    openclaw_session_key TEXT NOT NULL,
    status TEXT NOT NULL,
    mode TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    cost_microusd INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    failed_at TEXT,
    error_code TEXT,
    error_message TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_agent_runs_user_started
    ON agent_runs (user_id, started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_agent_runs_status_started
    ON agent_runs (status, started_at DESC);

  CREATE TABLE IF NOT EXISTS agent_message_feedback (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    rating TEXT NOT NULL,
    reason TEXT,
    comment TEXT,
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
  insertAgentRun: db.prepare(`
    INSERT INTO agent_runs (
      id, user_id, conversation_id, message_id, openclaw_run_id, openclaw_session_key,
      status, mode, provider, model, started_at
    )
    VALUES (
      @id, @userId, @conversationId, @messageId, @openClawRunId, @openClawSessionKey,
      @status, @mode, @provider, @model, @startedAt
    )
  `),
  getAgentRun: db.prepare(`
    SELECT * FROM agent_runs WHERE id = ? AND user_id = ? LIMIT 1
  `),
  updateAgentRunStatus: db.prepare(`
    UPDATE agent_runs
    SET status = @status,
      openclaw_run_id = COALESCE(@openClawRunId, openclaw_run_id),
      input_tokens = COALESCE(@inputTokens, input_tokens),
      output_tokens = COALESCE(@outputTokens, output_tokens),
      tool_call_count = COALESCE(@toolCallCount, tool_call_count),
      completed_at = @completedAt,
      failed_at = @failedAt,
      error_code = @errorCode,
      error_message = @errorMessage
    WHERE id = @id AND user_id = @userId
  `),
  insertAgentFeedback: db.prepare(`
    INSERT INTO agent_message_feedback (id, message_id, user_id, rating, reason, comment, created_at)
    VALUES (@id, @messageId, @userId, @rating, @reason, @comment, @createdAt)
  `),
};

const deepseekApiKey = process.env.DEEPSEEK_API_KEY || '';
const deepseekBaseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const cbetaApiRoot = (process.env.CBETA_API_ROOT || 'https://144.24.17.21.sslip.io').replace(/\/+$/, '');
const fabushiApiBaseUrl = (process.env.FABUSHI_API_BASE_URL || 'http://144.24.17.21').replace(/\/+$/, '');
const memberMonthlyLimit = Number(process.env.MEMBER_MONTHLY_TOKEN_LIMIT || 1_000_000);
const freeMonthlyLimit = Number(process.env.FREE_MONTHLY_TOKEN_LIMIT || 50_000);
const maxResourceTextChars = Number(process.env.MAX_RESOURCE_TEXT_CHARS || 80_000);
const enableLibreChatAgentChat = process.env.ENABLE_LIBRECHAT_AGENT_CHAT === 'true';
const libreChatAgentsBaseUrl = (
  process.env.LIBRECHAT_AGENTS_BASE_URL || 'http://127.0.0.1:3080/api/agents/v1'
).replace(/\/+$/, '');
const libreChatAgentApiKey = process.env.LIBRECHAT_AGENT_API_KEY || '';
const libreChatAgentId = process.env.LIBRECHAT_AGENT_ID || '';
const enableCodexSdkChat = process.env.ENABLE_CODEX_SDK_CHAT === 'true';
const enableOpenClawAgentChat = process.env.ENABLE_OPENCLAW_AGENT_CHAT === 'true';
const openClawGatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/+$/, '');
const openClawGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const openClawAgentId = process.env.OPENCLAW_AGENT_ID || 'fabushi-public-agent';
const openClawRunsEndpoint = process.env.OPENCLAW_RUNS_ENDPOINT || '';
const codexDeepSeekProviderId = 'deepseek-chat-completions';
const codexResponsesBaseUrl = (
  process.env.CODEX_DEEPSEEK_RESPONSES_BASE_URL ||
  `http://127.0.0.1:${process.env.PORT || 8788}/codex-deepseek/v1`
).replace(/\/+$/, '');

const systemPrompt = [
  '你是“大乘”App 的 AI 助手。',
  '你的核心任务是帮助用户查找、整理、理解并全球法布施合法可分享的佛法资源。',
  '回答要庄重、简洁、可执行；涉及经典、仪轨或资源时，提醒用户尊重版权、来源和当地法规。',
  '如果用户想找资源、下载经文、寻找音频或准备可分享资料，你必须先在后端自动执行搜索、验证和下载步骤；不要要求用户去前端 + 菜单手动查找。',
  '你可以把执行进度总结给用户，但不要输出隐藏推理原文。',
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

function textToolResult(text, structuredContent = {}) {
  return {
    structuredContent,
    content: [{ type: 'text', text }],
  };
}

function sseHeaders(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
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

async function callDeepSeekStream(messages, callbacks = {}) {
  if (!deepseekApiKey) {
    const error = new Error('DeepSeek API key is not configured');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(`${deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: deepseekModel,
      messages,
      temperature: 0.4,
      max_tokens: 1400,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: callbacks.signal || AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    let payload;
    try {
      payload = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      payload = { error: bodyText };
    }
    const upstreamMessage = payload?.error?.message || payload?.message || '';
    const friendlyMessage =
      response.status === 402 || /insufficient\s+balance/i.test(upstreamMessage)
        ? '大乘 AI 服务额度暂不可用，请联系管理员充值 DeepSeek 账户后重试。'
        : upstreamMessage || `DeepSeek request failed: ${response.status}`;
    const error = new Error(friendlyMessage);
    error.statusCode = response.status;
    throw error;
  }

  let buffer = '';
  let message = '';
  let usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const decoder = new TextDecoder();

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (!data || data === '[DONE]') continue;

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      const delta = payload?.choices?.[0]?.delta?.content || '';
      if (delta) {
        message += delta;
        callbacks.onToken?.(delta);
      }

      if (payload?.usage) {
        usage = {
          promptTokens: Number(payload.usage.prompt_tokens || usage.promptTokens || 0),
          completionTokens: Number(payload.usage.completion_tokens || usage.completionTokens || 0),
          totalTokens: Number(payload.usage.total_tokens || usage.totalTokens || 0),
        };
      }
    }
  }

  message = message.trim();
  if (!message) {
    const error = new Error('DeepSeek returned an empty response');
    error.statusCode = 502;
    throw error;
  }

  return { message, usage };
}

function createCodexDeepSeekRuntime() {
  if (!enableCodexSdkChat || !deepseekApiKey) {
    return {
      enabled: false,
      provider: 'deepseek-direct',
      reason: enableCodexSdkChat ? 'DeepSeek API key is not configured' : 'ENABLE_CODEX_SDK_CHAT is not true',
    };
  }

  return {
    enabled: true,
    provider: 'codex-sdk-deepseek',
    options: {
      apiKey: deepseekApiKey,
      baseUrl: deepseekBaseUrl,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: deepseekApiKey,
        HOME: codexHomeDir,
        CODEX_HOME: codexHomeDir,
        TMPDIR: codexTempDir,
        XDG_RUNTIME_DIR: codexRuntimeDir,
        XDG_CACHE_HOME: path.join(codexHomeDir, '.cache'),
        XDG_CONFIG_HOME: path.join(codexHomeDir, '.config'),
        XDG_DATA_HOME: path.join(codexHomeDir, '.local', 'share'),
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
      config: {
        model_provider: codexDeepSeekProviderId,
        model_providers: {
          [codexDeepSeekProviderId]: {
            name: 'DeepSeek Chat Completions',
            base_url: codexResponsesBaseUrl,
            env_key: 'DEEPSEEK_API_KEY',
            wire_api: 'responses',
            query_params: {},
          },
        },
      },
    },
    threadOptions: {
      model: deepseekModel,
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
      skipGitRepoCheck: true,
      networkAccessEnabled: true,
    },
  };
}

function codexPromptFromMessages(messages) {
  return messages
    .map((message) => {
      const role = String(message.role || 'user').toUpperCase();
      return `${role}:\n${message.content}`;
    })
    .join('\n\n');
}

function responseContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return String(part.text || part.input_text || part.output_text || '');
    })
    .filter(Boolean)
    .join('\n');
}

function codexResponsesPrompt(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const userItems = input.filter((item) => item?.role === 'user');
  const source = userItems[userItems.length - 1] || input[input.length - 1];
  const prompt = responseContentText(source?.content).trim();
  if (prompt) return prompt;
  if (typeof body?.input === 'string') return body.input.trim();
  return '';
}

function writeResponsesEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function responseUsage(usage = {}) {
  return {
    input_tokens: Number(usage.promptTokens || usage.input_tokens || 0),
    cached_input_tokens: 0,
    output_tokens: Number(usage.completionTokens || usage.output_tokens || 0),
    reasoning_output_tokens: 0,
    total_tokens: Number(usage.totalTokens || usage.total_tokens || 0),
  };
}

function createLibreChatAgentRuntime() {
  if (!enableLibreChatAgentChat || !libreChatAgentApiKey || !libreChatAgentId) {
    return {
      enabled: false,
      provider: 'librechat-agent',
      reason: !enableLibreChatAgentChat
        ? 'ENABLE_LIBRECHAT_AGENT_CHAT is not true'
        : !libreChatAgentApiKey
          ? 'LIBRECHAT_AGENT_API_KEY is not configured'
          : 'LIBRECHAT_AGENT_ID is not configured',
    };
  }

  return {
    enabled: true,
    provider: 'librechat-agent',
    model: libreChatAgentId,
    chatCompletionsUrl: `${libreChatAgentsBaseUrl}/chat/completions`,
  };
}

function libreChatUsage(usage = {}) {
  return {
    promptTokens: Number(usage.prompt_tokens || usage.input_tokens || usage.promptTokens || 0),
    completionTokens: Number(usage.completion_tokens || usage.output_tokens || usage.completionTokens || 0),
    totalTokens: Number(usage.total_tokens || usage.totalTokens || 0),
  };
}

async function callLibreChatAgent(messages) {
  const runtime = createLibreChatAgentRuntime();
  if (!runtime.enabled) {
    const error = new Error(runtime.reason || 'LibreChat Agent chat is not enabled');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(runtime.chatCompletionsUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${libreChatAgentApiKey}`,
    },
    body: JSON.stringify({
      model: runtime.model,
      messages,
      temperature: 0.4,
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const bodyText = await response.text();
  let payload;
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    payload = { error: bodyText };
  }

  if (!response.ok) {
    const upstreamMessage = payload?.error?.message || payload?.message || bodyText || '';
    const error = new Error(upstreamMessage || `LibreChat Agent request failed: ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  const message = payload?.choices?.[0]?.message?.content?.trim();
  if (!message) {
    const error = new Error('LibreChat Agent returned an empty response');
    error.statusCode = 502;
    throw error;
  }

  return {
    message,
    usage: libreChatUsage(payload?.usage),
  };
}

async function callLibreChatAgentStream(messages, callbacks = {}) {
  const runtime = createLibreChatAgentRuntime();
  if (!runtime.enabled) {
    const error = new Error(runtime.reason || 'LibreChat Agent chat is not enabled');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(runtime.chatCompletionsUrl, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${libreChatAgentApiKey}`,
    },
    body: JSON.stringify({
      model: runtime.model,
      messages,
      temperature: 0.4,
      stream: true,
    }),
    signal: callbacks.signal || AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    let payload;
    try {
      payload = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      payload = { error: bodyText };
    }
    const upstreamMessage = payload?.error?.message || payload?.message || bodyText || '';
    const error = new Error(upstreamMessage || `LibreChat Agent request failed: ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  let buffer = '';
  let message = '';
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const decoder = new TextDecoder();

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (!data || data === '[DONE]') continue;

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      const delta = payload?.choices?.[0]?.delta?.content || '';
      if (delta) {
        message += delta;
        callbacks.onToken?.(delta);
      }

      if (payload?.usage) {
        usage = libreChatUsage(payload.usage);
      }
    }
  }

  message = message.trim();
  if (!message) {
    const error = new Error('LibreChat Agent returned an empty response');
    error.statusCode = 502;
    throw error;
  }

  return { message, usage };
}

function isDeepSeekQuotaError(error) {
  const message = String(error?.message || error || '');
  return /额度|insufficient\s+balance|balance/i.test(message);
}

function publicAiErrorMessage(error) {
  if (isDeepSeekQuotaError(error)) {
    return '大乘 AI 服务额度暂不可用，请联系管理员充值 DeepSeek 账户后重试。';
  }
  return error?.message || 'Internal Server Error';
}

function responsesPayload({
  responseId,
  itemId,
  status,
  model,
  text = '',
  usage = null,
  error = null,
}) {
  return {
    id: responseId,
    object: 'response',
    status,
    model,
    output:
      status === 'completed'
        ? [
            {
              id: itemId,
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text }],
            },
          ]
        : [],
    ...(usage ? { usage: responseUsage(usage) } : {}),
    ...(error
      ? {
          error: {
            message: error.message || String(error),
            type: 'server_error',
          },
        }
      : {}),
  };
}

async function callCodexSdkDeepSeek(messages, callbacks = {}) {
  const codexRuntime = createCodexDeepSeekRuntime();
  if (!codexRuntime.enabled) {
    const error = new Error(codexRuntime.reason || 'Codex SDK chat is not enabled');
    error.statusCode = 503;
    throw error;
  }

  const { Codex } = await import('@openai/codex-sdk');
  const codex = new Codex(codexRuntime.options);
  const thread = codex.startThread(codexRuntime.threadOptions);
  const prompt = codexPromptFromMessages(messages);

  if (callbacks.onToken || callbacks.onStep) {
    const { events } = await thread.runStreamed(prompt, { signal: callbacks.signal });
    let finalResponse = '';
    let usage = null;

    for await (const event of events) {
      if (event.type === 'item.completed') {
        const item = event.item;
        if (item.type === 'agent_message') {
          finalResponse = item.text || finalResponse;
          callbacks.onToken?.(item.text || '');
        } else if (item.type === 'todo_list') {
          callbacks.onStep?.({
            title: 'Codex SDK 执行计划',
            message: item.items.map((todo) => `${todo.completed ? '✓' : '•'} ${todo.text}`).join('\n'),
          });
        } else if (item.type === 'command_execution') {
          callbacks.onStep?.({
            title: 'Codex SDK 执行命令',
            message: item.command,
          });
        } else if (item.type === 'mcp_tool_call') {
          callbacks.onStep?.({
            title: 'Codex SDK 调用工具',
            message: `${item.server}.${item.tool}`,
          });
        }
      } else if (event.type === 'turn.completed') {
        usage = event.usage;
      } else if (event.type === 'turn.failed') {
        throw new Error(event.error?.message || 'Codex SDK turn failed');
      } else if (event.type === 'error') {
        throw new Error(event.message || 'Codex SDK stream failed');
      }
    }

    if (!finalResponse.trim()) {
      const error = new Error('Codex SDK returned an empty response');
      error.statusCode = 502;
      throw error;
    }

    return {
      message: finalResponse.trim(),
      usage: {
        promptTokens: Number(usage?.input_tokens || 0),
        completionTokens: Number(usage?.output_tokens || 0),
        totalTokens: Number((usage?.input_tokens || 0) + (usage?.output_tokens || 0)),
      },
    };
  }

  const turn = await thread.run(prompt);
  if (!turn.finalResponse?.trim()) {
    const error = new Error('Codex SDK returned an empty response');
    error.statusCode = 502;
    throw error;
  }

  return {
    message: turn.finalResponse.trim(),
    usage: {
      promptTokens: Number(turn.usage?.input_tokens || 0),
      completionTokens: Number(turn.usage?.output_tokens || 0),
      totalTokens: Number((turn.usage?.input_tokens || 0) + (turn.usage?.output_tokens || 0)),
    },
  };
}

const activeAgentRuns = new Map();

function normalizeAgentMode(value) {
  const mode = safeUserText(value || 'dharma_guide');
  return /^[a-z][a-z0-9_:-]{0,48}$/i.test(mode) ? mode : 'dharma_guide';
}

function openClawSessionKey(user, conversationId) {
  const env = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
  return `fabushi:env:${env}:user:${user.userId}:conversation:${conversationId}`;
}

function createOpenClawRuntime() {
  if (!enableOpenClawAgentChat || !openClawGatewayToken || !openClawGatewayUrl) {
    return {
      enabled: false,
      provider: 'openclaw-gateway',
      reason: !enableOpenClawAgentChat
        ? 'ENABLE_OPENCLAW_AGENT_CHAT is not true'
        : !openClawGatewayToken
          ? 'OPENCLAW_GATEWAY_TOKEN is not configured'
          : 'OPENCLAW_GATEWAY_URL is not configured',
    };
  }

  return {
    enabled: true,
    provider: 'openclaw-gateway',
    model: openClawAgentId,
    runsUrl: openClawRunsEndpoint || `${openClawGatewayUrl}/v1/agents/${encodeURIComponent(openClawAgentId)}/runs`,
  };
}

function extractOpenClawText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.message,
    payload.content,
    payload.output_text,
    payload.finalResponse,
    payload.final_response,
    payload.result?.message,
    payload.result?.content,
    payload.output?.message,
    payload.output?.content,
    payload.choices?.[0]?.message?.content,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function extractOpenClawUsage(payload) {
  const usage = payload?.usage || payload?.result?.usage || {};
  return {
    promptTokens: Number(usage.input_tokens || usage.prompt_tokens || usage.promptTokens || 0),
    completionTokens: Number(usage.output_tokens || usage.completion_tokens || usage.completionTokens || 0),
    totalTokens: Number(usage.total_tokens || usage.totalTokens || 0),
  };
}

async function callOpenClawAgent({ messages, user, conversationId, mode, signal }) {
  const runtime = createOpenClawRuntime();
  if (!runtime.enabled) {
    const error = new Error(runtime.reason || 'OpenClaw Agent chat is not enabled');
    error.statusCode = 503;
    throw error;
  }

  const sessionKey = openClawSessionKey(user, conversationId);
  const response = await fetch(runtime.runsUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openClawGatewayToken}`,
    },
    body: JSON.stringify({
      agentId: openClawAgentId,
      sessionKey,
      mode,
      stream: false,
      input: { messages },
      messages,
      metadata: {
        app: 'fabushi',
        userId: user.userId,
        conversationId,
        toolPolicy: 'public-user-read-mostly',
      },
    }),
    signal: signal || AbortSignal.timeout(180_000),
  });

  const bodyText = await response.text();
  let payload;
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    payload = { message: bodyText };
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || `OpenClaw request failed: ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  const message = extractOpenClawText(payload);
  if (!message) {
    const error = new Error('OpenClaw returned an empty response');
    error.statusCode = 502;
    throw error;
  }

  return {
    message,
    runId: payload.runId || payload.id || payload.result?.runId || null,
    provider: runtime.provider,
    model: runtime.model,
    usage: extractOpenClawUsage(payload),
  };
}

async function runAgentModel({ messages, user, conversationId, mode, callbacks = {}, signal }) {
  const openClawRuntime = createOpenClawRuntime();
  if (openClawRuntime.enabled && !callbacks.onToken) {
    return await callOpenClawAgent({ messages, user, conversationId, mode, signal });
  }

  const codexRuntime = createCodexDeepSeekRuntime();
  const libreChatRuntime = createLibreChatAgentRuntime();
  let provider = libreChatRuntime.enabled
    ? libreChatRuntime.provider
    : codexRuntime.enabled
      ? codexRuntime.provider
      : 'deepseek';
  let model = libreChatRuntime.enabled ? libreChatRuntime.model : deepseekModel;

  try {
    if (libreChatRuntime.enabled) {
      const result = callbacks.onToken
        ? await callLibreChatAgentStream(messages, { ...callbacks, signal })
        : await callLibreChatAgent(messages);
      return { ...result, provider, model };
    }
    if (codexRuntime.enabled) {
      const result = await callCodexSdkDeepSeek(messages, { ...callbacks, signal });
      return { ...result, provider, model };
    }
    const result = callbacks.onToken
      ? await callDeepSeekStream(messages, { ...callbacks, signal })
      : await callDeepSeek(messages);
    return { ...result, provider, model };
  } catch (error) {
    if (!codexRuntime.enabled || isDeepSeekQuotaError(error)) throw error;
    logger.warn({ error: String(error) }, 'Agent model failed, falling back to DeepSeek direct');
    const result = callbacks.onToken
      ? await callDeepSeekStream(messages, { ...callbacks, signal })
      : await callDeepSeek(messages);
    return { ...result, provider: 'deepseek', model: deepseekModel };
  }
}

function updateAgentRunStatus(run, status, fields = {}) {
  statements.updateAgentRunStatus.run({
    id: run.id,
    userId: run.user_id || run.userId,
    status,
    openClawRunId: fields.openClawRunId ?? null,
    inputTokens: fields.inputTokens ?? null,
    outputTokens: fields.outputTokens ?? null,
    toolCallCount: fields.toolCallCount ?? null,
    completedAt: status === 'completed' || status === 'cancelled' ? nowIso() : null,
    failedAt: status === 'failed' ? nowIso() : null,
    errorCode: fields.errorCode ?? null,
    errorMessage: fields.errorMessage ?? null,
  });
}

function buildAgentMessages(conversationId) {
  const historyRows = statements.listMessages.all(conversationId).slice(-14);
  return [{ role: 'system', content: systemPrompt }, ...normalizeMessages(historyRows)];
}

function agentUsagePayload(usage, user, budget) {
  const promptTokens = usage.promptTokens || usage.inputTokens || 0;
  const completionTokens = usage.completionTokens || usage.outputTokens || 0;
  const totalTokens = usage.totalTokens || promptTokens + completionTokens;
  const latestUsage = usageFor(user.userId);
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens,
    monthlyLimit: budget.limit,
    remainingTokens: Math.max(0, budget.limit - latestUsage.used),
  };
}

app.post(
  '/codex-deepseek/v1/responses',
  asyncHandler(async (req, res) => {
    const bearer = bearerToken(req);
    if (!deepseekApiKey || bearer !== deepseekApiKey) {
      res.status(401).json({
        error: { message: 'Unauthorized Codex DeepSeek adapter request' },
      });
      return;
    }

    const prompt = codexResponsesPrompt(req.body);
    if (!prompt) {
      res.status(400).json({ error: { message: 'Responses input is required' } });
      return;
    }

    const model = String(req.body?.model || deepseekModel);
    const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;
    const itemId = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
    const wantsStream =
      req.body?.stream !== false ||
      String(req.get('accept') || '').includes('text/event-stream');
    const messages = [{ role: 'user', content: prompt }];

    if (!wantsStream) {
      const result = await callDeepSeek(messages);
      res.json(
        responsesPayload({
          responseId,
          itemId,
          status: 'completed',
          model,
          text: result.message,
          usage: result.usage,
        }),
      );
      return;
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    writeResponsesEvent(res, 'response.created', {
      type: 'response.created',
      response: responsesPayload({
        responseId,
        itemId,
        status: 'in_progress',
        model,
      }),
    });
    writeResponsesEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
    });
    writeResponsesEvent(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    });

    let text = '';
    try {
      const result = await callDeepSeekStream(messages, {
        onToken: (delta) => {
          text += delta;
          writeResponsesEvent(res, 'response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta,
          });
        },
      });
      text = result.message || text;
      writeResponsesEvent(res, 'response.output_text.done', {
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text,
      });
      writeResponsesEvent(res, 'response.content_part.done', {
        type: 'response.content_part.done',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text },
      });
      writeResponsesEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text }],
        },
      });
      writeResponsesEvent(res, 'response.completed', {
        type: 'response.completed',
        response: responsesPayload({
          responseId,
          itemId,
          status: 'completed',
          model,
          text,
          usage: result.usage,
        }),
      });
      res.end();
    } catch (error) {
      writeResponsesEvent(res, 'response.failed', {
        type: 'response.failed',
        response: responsesPayload({
          responseId,
          itemId,
          status: 'failed',
          model,
          text,
          error,
        }),
      });
      res.end();
    }
  }),
);

app.get('/health', (_req, res) => {
  const codexRuntime = createCodexDeepSeekRuntime();
  const libreChatRuntime = createLibreChatAgentRuntime();
  const openClawRuntime = createOpenClawRuntime();
  jsonResponse(res, 200, {
    status: 'ok',
    service: 'dacheng-ai-backend',
    provider: libreChatRuntime.enabled ? libreChatRuntime.provider : 'deepseek',
    model: libreChatRuntime.enabled ? libreChatRuntime.model : deepseekModel,
    libreChatAgentChatEnabled: libreChatRuntime.enabled,
    libreChatAgentProvider: libreChatRuntime.provider,
    libreChatAgentReason: libreChatRuntime.enabled ? undefined : libreChatRuntime.reason,
    codexSdkAvailable: true,
    codexSdkChatEnabled: codexRuntime.enabled,
    codexSdkProvider: codexRuntime.provider,
    openClawAgentChatEnabled: openClawRuntime.enabled,
    openClawAgentProvider: openClawRuntime.provider,
    openClawAgentReason: openClawRuntime.enabled ? undefined : openClawRuntime.reason,
    cbetaApiRoot,
    timestamp: nowIso(),
  });
});

app.post(
  '/api/agent/chat',
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
    const mode = normalizeAgentMode(req.body?.mode);
    const stream = req.body?.stream === true;
    let conversation = statements.getConversation.get(conversationId, user.userId);
    const isNewConversation = !conversation;

    if (isNewConversation) {
      conversation = { id: conversationId, user_id: user.userId, title: titleFromMessage(message) };
      statements.insertConversation.run({
        id: conversationId,
        userId: user.userId,
        title: conversation.title,
        provider: 'agent',
        model: openClawAgentId,
        createdAt,
        updatedAt: createdAt,
      });
    }

    const messageId = safeUserText(req.body?.messageId) || crypto.randomUUID();
    statements.insertMessage.run({
      id: messageId,
      conversationId,
      role: 'user',
      content: message,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      createdAt,
    });

    const runId = `run_${crypto.randomUUID().replaceAll('-', '')}`;
    const sessionKey = openClawSessionKey(user, conversationId);
    const openClawRuntime = createOpenClawRuntime();
    statements.insertAgentRun.run({
      id: runId,
      userId: user.userId,
      conversationId,
      messageId,
      openClawRunId: null,
      openClawSessionKey: sessionKey,
      status: stream ? 'queued' : 'running',
      mode,
      provider: openClawRuntime.enabled ? openClawRuntime.provider : 'dacheng-ai-fallback',
      model: openClawRuntime.enabled ? openClawAgentId : deepseekModel,
      startedAt: createdAt,
    });

    if (stream) {
      return jsonResponse(res, 200, {
        success: true,
        runId,
        conversationId,
        streamUrl: `/api/agent/runs/${runId}/events`,
      });
    }

    const controller = new AbortController();
    activeAgentRuns.set(runId, controller);
    try {
      const modelMessages = buildAgentMessages(conversationId);
      const aiResult = await runAgentModel({
        messages: modelMessages,
        user,
        conversationId,
        mode,
        signal: controller.signal,
      });
      const usage = {
        promptTokens: aiResult.usage?.promptTokens || estimateTokens(JSON.stringify(modelMessages)),
        completionTokens: aiResult.usage?.completionTokens || estimateTokens(aiResult.message),
        totalTokens:
          aiResult.usage?.totalTokens ||
          estimateTokens(JSON.stringify(modelMessages)) + estimateTokens(aiResult.message),
      };
      recordUsage(user.userId, usage.totalTokens);
      const answeredAt = nowIso();
      const assistantMessageId = crypto.randomUUID();
      statements.insertMessage.run({
        id: assistantMessageId,
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
      updateAgentRunStatus({ id: runId, user_id: user.userId }, 'completed', {
        openClawRunId: aiResult.runId,
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
      });
      return jsonResponse(res, 200, {
        success: true,
        runId,
        conversationId,
        messageId: assistantMessageId,
        provider: aiResult.provider,
        model: aiResult.model,
        message: aiResult.message,
        usage: agentUsagePayload(usage, user, budget),
      });
    } catch (error) {
      const status = error.name === 'AbortError' ? 'cancelled' : 'failed';
      updateAgentRunStatus({ id: runId, user_id: user.userId }, status, {
        errorCode: error.name || 'AGENT_RUN_FAILED',
        errorMessage: publicAiErrorMessage(error),
      });
      if (status === 'cancelled') {
        return jsonResponse(res, 499, { success: false, runId, status: 'cancelled' });
      }
      throw error;
    } finally {
      activeAgentRuns.delete(runId);
    }
  }),
);

app.get(
  '/api/agent/runs/:runId/events',
  asyncHandler(async (req, res) => {
    const user = await resolveUser(req, {});
    const run = statements.getAgentRun.get(req.params.runId, user.userId);
    if (!run) {
      return jsonResponse(res, 404, { success: false, message: 'run not found' });
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return jsonResponse(res, 409, { success: false, message: `run is already ${run.status}` });
    }

    sseHeaders(res);
    const controller = new AbortController();
    activeAgentRuns.set(run.id, controller);
    updateAgentRunStatus(run, 'running');
    writeSse(res, 'run.started', { runId: run.id, conversationId: run.conversation_id });

    try {
      const estimated = 600;
      const budget = enforceTokenBudget(user, estimated);
      let streamedText = '';
      const modelMessages = buildAgentMessages(run.conversation_id);
      const aiResult = await runAgentModel({
        messages: modelMessages,
        user,
        conversationId: run.conversation_id,
        mode: run.mode,
        signal: controller.signal,
        callbacks: {
          onStep: (step) => writeSse(res, 'tool.call.completed', {
            tool: 'agent.step',
            displayName: step.title || 'Agent step',
            summary: step.message || '',
          }),
          onToken: (delta) => {
            streamedText += delta;
            writeSse(res, 'assistant.delta', { text: delta });
          },
        },
      });
      const message = aiResult.message || streamedText.trim();
      const usage = {
        promptTokens: aiResult.usage?.promptTokens || estimateTokens(JSON.stringify(modelMessages)),
        completionTokens: aiResult.usage?.completionTokens || estimateTokens(message),
        totalTokens:
          aiResult.usage?.totalTokens || estimateTokens(JSON.stringify(modelMessages)) + estimateTokens(message),
      };
      recordUsage(user.userId, usage.totalTokens);
      const assistantMessageId = crypto.randomUUID();
      const answeredAt = nowIso();
      statements.insertMessage.run({
        id: assistantMessageId,
        conversationId: run.conversation_id,
        role: 'assistant',
        content: message,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        createdAt: answeredAt,
      });
      statements.updateConversation.run({
        id: run.conversation_id,
        userId: user.userId,
        title: titleFromMessage(message),
        updatedAt: answeredAt,
      });
      updateAgentRunStatus(run, 'completed', {
        openClawRunId: aiResult.runId,
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
      });
      writeSse(res, 'assistant.message', { messageId: assistantMessageId, content: message });
      writeSse(res, 'run.completed', { usage: agentUsagePayload(usage, user, budget) });
      res.end();
    } catch (error) {
      const status = error.name === 'AbortError' ? 'cancelled' : 'failed';
      updateAgentRunStatus(run, status, {
        errorCode: error.name || 'AGENT_RUN_FAILED',
        errorMessage: publicAiErrorMessage(error),
      });
      writeSse(res, status === 'cancelled' ? 'run.cancelled' : 'run.failed', {
        runId: run.id,
        message: publicAiErrorMessage(error),
      });
      res.end();
    } finally {
      activeAgentRuns.delete(run.id);
    }
  }),
);

app.post(
  '/api/agent/runs/:runId/cancel',
  asyncHandler(async (req, res) => {
    const user = await resolveUser(req, req.body || {});
    const run = statements.getAgentRun.get(req.params.runId, user.userId);
    if (!run) {
      return jsonResponse(res, 404, { success: false, message: 'run not found' });
    }
    const controller = activeAgentRuns.get(run.id);
    if (controller) controller.abort();
    updateAgentRunStatus(run, 'cancelled');
    return jsonResponse(res, 200, { success: true, runId: run.id, status: 'cancelled' });
  }),
);

app.post(
  '/api/agent/messages/:messageId/feedback',
  asyncHandler(async (req, res) => {
    const user = await resolveUser(req, req.body || {});
    const rating = safeUserText(req.body?.rating);
    if (!['up', 'down'].includes(rating)) {
      return jsonResponse(res, 400, { success: false, message: 'rating must be up or down' });
    }
    statements.insertAgentFeedback.run({
      id: crypto.randomUUID(),
      messageId: req.params.messageId,
      userId: user.userId,
      rating,
      reason: safeUserText(req.body?.reason),
      comment: safeUserText(req.body?.comment),
      createdAt: nowIso(),
    });
    return jsonResponse(res, 200, { success: true });
  }),
);

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

    const libreChatRuntime = createLibreChatAgentRuntime();
    const skillResult = await runResourceFinderSkill({ message, user });
    const skillContext = resourceContextMessage(skillResult);
    const historyRows = statements.listMessages.all(conversationId).slice(-14);
    const modelMessages = [
      { role: 'system', content: systemPrompt },
      ...(skillContext ? [{ role: 'system', content: skillContext }] : []),
      ...normalizeMessages(historyRows),
    ];

    const openClawRuntime = createOpenClawRuntime();
    const codexRuntime = createCodexDeepSeekRuntime();
    let provider = openClawRuntime.enabled
      ? openClawRuntime.provider
      : libreChatRuntime.enabled
        ? libreChatRuntime.provider
        : 'deepseek';
    let responseModel = openClawRuntime.enabled
      ? openClawRuntime.model
      : libreChatRuntime.enabled
        ? libreChatRuntime.model
        : deepseekModel;
    let aiResult;
    try {
      if (openClawRuntime.enabled) {
        aiResult = await callOpenClawAgent({
          messages: modelMessages,
          user,
          conversationId,
          mode: normalizeAgentMode(req.body?.mode),
        });
        provider = aiResult.provider || provider;
        responseModel = aiResult.model || responseModel;
      } else if (libreChatRuntime.enabled) {
        aiResult = await callLibreChatAgent(modelMessages);
      } else if (codexRuntime.enabled) {
        provider = codexRuntime.provider;
        aiResult = await callCodexSdkDeepSeek(modelMessages);
      } else {
        aiResult = await callDeepSeek(modelMessages);
      }
    } catch (error) {
      if (libreChatRuntime.enabled) {
        logger.warn({ error: String(error) }, 'LibreChat Agent chat failed, falling back to Codex SDK or DeepSeek direct');
        provider = codexRuntime.enabled ? codexRuntime.provider : 'deepseek';
        responseModel = deepseekModel;
        if (codexRuntime.enabled) {
          try {
            aiResult = await callCodexSdkDeepSeek(modelMessages);
          } catch (codexError) {
            if (isDeepSeekQuotaError(codexError)) throw codexError;
            logger.warn({ error: String(codexError) }, 'Codex SDK chat failed, falling back to DeepSeek direct');
            provider = 'deepseek';
            aiResult = await callDeepSeek(modelMessages);
          }
        } else {
          aiResult = await callDeepSeek(modelMessages);
        }
      } else {
        if (!codexRuntime.enabled || isDeepSeekQuotaError(error)) throw error;
        logger.warn({ error: String(error) }, 'Codex SDK chat failed, falling back to DeepSeek direct');
        provider = 'deepseek';
        aiResult = await callDeepSeek(modelMessages);
      }
    }
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
      provider,
      model: responseModel,
      message: aiResult.message,
      usage: {
        ...usage,
        monthlyLimit,
        remainingTokens: Math.max(0, monthlyLimit - latestUsage.used),
      },
    });
  }),
);

app.post('/api/ai/chat/stream', async (req, res) => {
  sseHeaders(res);

  try {
    const message = safeUserText(req.body?.message);
    if (!message) {
      writeSse(res, 'error', { message: 'message is required' });
      res.end();
      return;
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

    const codexRuntime = createCodexDeepSeekRuntime();
    const libreChatRuntime = createLibreChatAgentRuntime();
    const initialOpenClawRuntime = createOpenClawRuntime();
    let provider = initialOpenClawRuntime.enabled
      ? initialOpenClawRuntime.provider
      : libreChatRuntime.enabled
        ? libreChatRuntime.provider
        : codexRuntime.enabled
          ? codexRuntime.provider
          : 'deepseek';
    let responseModel = initialOpenClawRuntime.enabled
      ? initialOpenClawRuntime.model
      : libreChatRuntime.enabled
        ? libreChatRuntime.model
        : deepseekModel;
    writeSse(res, 'meta', {
      conversationId,
      provider,
      model: responseModel,
    });
    const skillResult = await runResourceFinderSkill({
      message,
      user,
      onStep: (step) => writeSse(res, 'step', step),
    });
    const skillContext = resourceContextMessage(skillResult);
    const historyRows = statements.listMessages.all(conversationId).slice(-14);
    const modelMessages = [
      { role: 'system', content: systemPrompt },
      ...(skillContext ? [{ role: 'system', content: skillContext }] : []),
      ...normalizeMessages(historyRows),
    ];

    let aiResult;
    const openClawRuntime = initialOpenClawRuntime;
    try {
      if (openClawRuntime.enabled) {
        aiResult = await callOpenClawAgent({
          messages: modelMessages,
          user,
          conversationId,
          mode: normalizeAgentMode(req.body?.mode),
        });
        provider = aiResult.provider || provider;
        responseModel = aiResult.model || responseModel;
        writeSse(res, 'delta', { text: aiResult.message });
      } else if (libreChatRuntime.enabled) {
        aiResult = await callLibreChatAgentStream(modelMessages, {
          onToken: (token) => writeSse(res, 'delta', { text: token }),
        });
      } else if (codexRuntime.enabled) {
        aiResult = await callCodexSdkDeepSeek(modelMessages, {
          onToken: (token) => writeSse(res, 'delta', { text: token }),
          onStep: (step) => writeSse(res, 'step', step),
        });
      } else {
        aiResult = await callDeepSeekStream(modelMessages, {
          onToken: (token) => writeSse(res, 'delta', { text: token }),
        });
      }
    } catch (error) {
      if (libreChatRuntime.enabled) {
        logger.warn({ error: String(error) }, 'LibreChat Agent streaming chat failed, falling back to Codex SDK or DeepSeek direct');
        provider = codexRuntime.enabled ? codexRuntime.provider : 'deepseek';
        responseModel = deepseekModel;
        writeSse(res, 'meta', {
          conversationId,
          provider,
          model: responseModel,
        });
        if (codexRuntime.enabled) {
          try {
            aiResult = await callCodexSdkDeepSeek(modelMessages, {
              onToken: (token) => writeSse(res, 'delta', { text: token }),
              onStep: (step) => writeSse(res, 'step', step),
            });
          } catch (codexError) {
            if (isDeepSeekQuotaError(codexError)) throw codexError;
            logger.warn({ error: String(codexError) }, 'Codex SDK streaming chat failed, falling back to DeepSeek direct');
            provider = 'deepseek';
            responseModel = deepseekModel;
            writeSse(res, 'meta', {
              conversationId,
              provider,
              model: responseModel,
            });
            aiResult = await callDeepSeekStream(modelMessages, {
              onToken: (token) => writeSse(res, 'delta', { text: token }),
            });
          }
        } else {
          aiResult = await callDeepSeekStream(modelMessages, {
            onToken: (token) => writeSse(res, 'delta', { text: token }),
          });
        }
      } else {
        if (!codexRuntime.enabled || isDeepSeekQuotaError(error)) throw error;
        logger.warn({ error: String(error) }, 'Codex SDK streaming chat failed, falling back to DeepSeek direct');
        provider = 'deepseek';
        responseModel = deepseekModel;
        writeSse(res, 'meta', {
          conversationId,
          provider,
          model: responseModel,
        });
        aiResult = await callDeepSeekStream(modelMessages, {
          onToken: (token) => writeSse(res, 'delta', { text: token }),
        });
      }
    }

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
    writeSse(res, 'done', {
      conversationId,
      provider,
      model: responseModel,
      message: aiResult.message,
      usage: {
        ...usage,
        monthlyLimit,
        remainingTokens: Math.max(0, monthlyLimit - latestUsage.used),
      },
    });
    res.end();
  } catch (error) {
    logger.error({ error: error.stack || String(error) }, 'streaming chat failed');
    writeSse(res, 'error', {
      message: publicAiErrorMessage(error),
      details: error.details,
    });
    res.end();
  }
});

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
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') {
          url.searchParams.append(key, String(item));
        }
      }
    } else if (value !== undefined && value !== null && value !== '') {
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

function looksLikeAudioQuery(query) {
  return /音乐|音樂|音频|音訊|mp3|audio|念诵|念誦|诵经|誦經|唱诵|唱誦|读诵|讀誦/.test(
    safeUserText(query).toLowerCase(),
  );
}

function archiveSearchTerm(query) {
  return (
    safeUserText(query)
      .replace(/下载|查找|寻找|找一?个|资源|音频|音訊|音乐|音樂|mp3|audio|念诵|念誦|诵经|誦經|唱诵|唱誦|读诵|讀誦/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim() || safeUserText(query)
  );
}

function solrPhrase(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function searchInternetArchiveAudio(query, limit) {
  if (!looksLikeAudioQuery(query)) return [];
  const term = archiveSearchTerm(query);
  if (!term) return [];
  const variants = Array.from(
    new Set([
      term,
      term.replaceAll('金刚经', '金剛經'),
      term.replaceAll('金剛經', '金刚经'),
    ].filter(Boolean)),
  );
  const phraseQuery = variants
    .flatMap((item) => [`title:"${solrPhrase(item)}"`, `description:"${solrPhrase(item)}"`])
    .join(' OR ');
  const url = buildUrl('https://archive.org', 'advancedsearch.php', {
    q: `(${phraseQuery}) AND mediatype:audio`,
    rows: Math.min(Math.max(limit, 1), 10),
    output: 'json',
    'fl[]': ['identifier', 'title', 'description'],
  });
  const data = await fetchJson(url);
  const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];
  return docs
    .map((item) => {
      const identifier = firstText(item, ['identifier']);
      const title = firstText(item, ['title']) || identifier;
      if (!identifier || !title) return null;
      return {
        id: `ia-audio-${identifier}`,
        title,
        sourceName: 'Internet Archive 音频',
        url: `ia:${identifier}`,
        snippet: compactText(firstText(item, ['description'])) || '公开可访问的音频资源，将下载第一个可用 MP3 文件。',
        resourceType: 'audio',
        identifier,
      };
    })
    .filter(Boolean);
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

async function findResourceCandidates(query, limit) {
  const direct = directUrlResource(query);
  const results = [];
  if (direct) results.push(direct);
  try {
    results.push(...(await searchInternetArchiveAudio(query, limit)));
  } catch (error) {
    logger.warn({ error: String(error), query }, 'Internet Archive audio search skipped');
  }
  results.push(...localCbetaResults(query, limit));

  const [titleResults, contentResults] = await Promise.allSettled([
    searchCbetaTitle(query, limit),
    searchCbetaContent(query, limit),
  ]);
  if (titleResults.status === 'fulfilled') results.push(...titleResults.value);
  if (contentResults.status === 'fulfilled') results.push(...contentResults.value);

  return uniqueResources(results, limit);
}

function looksLikeResourceTask(message) {
  const text = safeUserText(message).toLowerCase();
  if (!text) return false;
  return /下载|查找|寻找|找一?个|资源|經文|经文|佛经|佛經|仪轨|儀軌|音乐|音樂|mp3|audio|念诵|念誦|诵经|誦經/.test(text);
}

function extractResourceQuery(message) {
  const text = safeUserText(message)
    .replace(/请|請|帮我|幫我|麻烦|麻煩|可以|能不能|需要|我要|想要/g, ' ')
    .replace(/下载|下載|查找|寻找|尋找|找一个|找一個|找|资源|資源|并|並|然后|然後|用于|用於|全球法布施|加入功课本|加入功課本/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || safeUserText(message);
}

function resourceContextMessage(skillResult) {
  if (!skillResult) return '';
  const lines = [
    '本轮资源检索/下载已经由大乘 App 后端完成。',
    '不要再次调用 search_dharma_resources、download_dharma_resource 或其他资源 MCP 工具；请直接基于以下结果回答用户。',
    `后端已调用 skill: ${skillResult.skillName}`,
    `执行目标: ${skillResult.query}`,
  ];
  if (skillResult.selected) {
    lines.push(`候选资源: ${skillResult.selected.title}`);
    lines.push(`来源: ${skillResult.selected.sourceName}`);
    lines.push(`资源地址: ${skillResult.selected.url}`);
  }
  if (skillResult.downloaded) {
    lines.push(`下载标题: ${skillResult.downloaded.title}`);
    lines.push(`下载文件: ${skillResult.downloaded.fileName}`);
    const text = safeUserText(skillResult.downloaded.contentText);
    if (text) {
      lines.push('下载正文摘录:');
      lines.push(text.slice(0, 8000));
    }
  }
  return lines.join('\n');
}

async function runResourceFinderSkill({ message, user, onStep }) {
  if (!looksLikeResourceTask(message)) return null;

  const skillName = 'resource-finder-downloader';
  const query = extractResourceQuery(message);
  const audioTask = looksLikeAudioQuery(message) || looksLikeAudioQuery(query);
  onStep?.({
    type: 'skill.step',
    skillName,
    stage: 'start',
    title: '调用资源查找下载 skill',
    message: `识别到资源任务: ${query}`,
  });

  onStep?.({
    type: 'skill.step',
    skillName,
    stage: 'search',
    title: '搜索可分享资源',
    message: audioTask
      ? '优先检索公开可访问音频资源，失败时再回落到佛典正文资源。'
      : '优先检索 CBETA 佛典正文接口，搜索索引不可用时使用内置经典映射。',
  });
  const candidates = await findResourceCandidates(query, 8);
  if (candidates.length === 0) {
    onStep?.({
      type: 'skill.step',
      skillName,
      stage: 'empty',
      title: '没有找到可下载资源',
      message: '后端没有找到明确可下载且可分享的资源。',
    });
    return {
      skillName,
      query,
      candidates: [],
      selected: null,
      downloaded: null,
    };
  }

  const selected = candidates[0];
  onStep?.({
    type: 'skill.step',
    skillName,
    stage: 'select',
    title: '选择可信候选资源',
    message: `${selected.title} / ${selected.sourceName}`,
  });

  onStep?.({
    type: 'skill.step',
    skillName,
    stage: 'download',
    title: '下载并提取资源',
    message: selected.url,
  });
  const cbeta = parseCbetaResource(selected);
  const internetArchive = parseInternetArchiveResource(selected);
  const downloaded = cbeta
    ? await downloadCbetaResource({ ...selected, ...cbeta })
    : internetArchive
      ? await downloadInternetArchiveAudio({ ...selected, ...internetArchive })
      : await downloadWebResource(selected);
  const persisted = persistDownloadedResource(user, downloaded);

  onStep?.({
    type: 'skill.step',
    skillName,
    stage: 'done',
    title: '资源已准备完成',
    message: downloaded.fileName,
  });

  return {
    skillName,
    query,
    candidates,
    selected,
    downloaded: {
      ...downloaded,
      downloadId: persisted.id,
    },
  };
}

app.post(
  '/api/resources/search',
  asyncHandler(async (req, res) => {
    const query = safeUserText(req.body?.query);
    const limit = Math.min(Math.max(Number(req.body?.limit || 12), 1), 20);
    if (query.length < 2) {
      return jsonResponse(res, 400, { success: false, message: 'query is required' });
    }

    const items = await findResourceCandidates(query, limit);

    jsonResponse(res, 200, {
      success: true,
      source: 'resource-index',
      items,
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

function parseInternetArchiveResource(input) {
  const url = safeUserText(input.url);
  const match = /^ia:([^:]+)$/i.exec(url);
  const identifier = match?.[1] || safeUserText(input.identifier);
  if (!identifier) return null;
  return { identifier };
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

async function downloadInternetArchiveAudio(resource) {
  const identifier = safeUserText(resource.identifier);
  if (!identifier) throw new Error('Internet Archive identifier is required');
  const metadata = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
  const title = safeUserText(metadata?.metadata?.title) || safeUserText(resource.title) || identifier;
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const audioFile = files.find((file) => {
    const name = safeUserText(file?.name);
    const format = safeUserText(file?.format).toLowerCase();
    return /\.(mp3|m4a|ogg)$/i.test(name) || format.includes('mp3');
  });
  if (!audioFile?.name) {
    throw new Error('Internet Archive audio item has no downloadable audio file');
  }
  const sourceFileName = audioFile.name;
  const fileUrl = `https://archive.org/download/${encodeURIComponent(identifier)}/${sourceFileName
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
  const response = await fetch(fileUrl, {
    headers: {
      Accept: 'audio/mpeg, audio/*;q=0.9, */*;q=0.5',
      'User-Agent': 'DachengResourceDownloader/1.0 (+https://ombhrum.com)',
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Internet Archive audio download failed: ${response.status}`);
  }
  const binaryContent = Buffer.from(await response.arrayBuffer());
  if (!binaryContent.length) throw new Error('Internet Archive audio returned empty content');
  const sizeMb = (binaryContent.length / 1024 / 1024).toFixed(1);
  return {
    title,
    sourceName: 'Internet Archive 音频',
    url: fileUrl,
    contentText: `已下载音频资源: ${title}\n文件名: ${sourceFileName}\n大小: ${sizeMb} MB\n来源: ${fileUrl}`,
    binaryContent,
    fileName: safeFileName(sourceFileName),
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
  if (content.binaryContent) {
    fs.writeFileSync(filePath, content.binaryContent);
  } else {
    fs.writeFileSync(filePath, content.contentText, 'utf8');
  }
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
  return { id, fileName, filePath };
}

function createLibreChatMcpServer() {
  const server = new McpServer({
    name: 'dacheng-ai-tools',
    version: '0.1.0',
  });

  server.registerTool(
    'search_dharma_resources',
    {
      title: 'Search dharma resources',
      description:
        'Search for legally shareable Buddhist scripture, text, web, or audio resources that can be prepared for Fabushi sharing.',
      inputSchema: {
        query: z.string().min(2).max(200),
        limit: z.number().int().min(1).max(12).optional(),
      },
      outputSchema: {
        query: z.string(),
        items: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            sourceName: z.string(),
            url: z.string(),
            snippet: z.string(),
            resourceType: z.string(),
            work: z.string().optional(),
            juan: z.number().optional(),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, limit }) => {
      const items = await findResourceCandidates(query, limit ?? 8);
      return textToolResult(`Found ${items.length} candidate resources for "${query}".`, {
        query,
        items,
      });
    },
  );

  server.registerTool(
    'download_dharma_resource',
    {
      title: 'Download dharma resource',
      description:
        'Download and extract a selected resource. Use the url/work/juan returned by search_dharma_resources whenever possible.',
      inputSchema: {
        url: z.string().min(1).max(1000),
        title: z.string().max(300).optional(),
        sourceName: z.string().max(120).optional(),
        work: z.string().max(40).optional(),
        juan: z.number().int().min(1).optional(),
        identifier: z.string().max(300).optional(),
      },
      outputSchema: {
        title: z.string(),
        sourceName: z.string(),
        url: z.string(),
        fileName: z.string(),
        downloadId: z.string(),
        contentText: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const user = { userId: 'librechat:mcp' };
      const cbeta = parseCbetaResource(input);
      const internetArchive = parseInternetArchiveResource(input);
      const content = cbeta
        ? await downloadCbetaResource({ ...input, ...cbeta })
        : internetArchive
          ? await downloadInternetArchiveAudio({ ...input, ...internetArchive })
          : await downloadWebResource(input);
      const persisted = persistDownloadedResource(user, content);
      const { binaryContent: _binaryContent, ...publicContent } = content;
      return textToolResult(`Downloaded ${publicContent.title} as ${publicContent.fileName}.`, {
        ...publicContent,
        downloadId: persisted.id,
      });
    },
  );

  server.registerTool(
    'prepare_dharma_share_text',
    {
      title: 'Prepare dharma sharing text',
      description:
        'Prepare a text payload for the Fabushi app to confirm and add to global dharma sharing. This returns a clientAction; it does not start sending.',
      inputSchema: {
        title: z.string().min(1).max(120),
        text: z.string().min(1).max(20000),
      },
      outputSchema: {
        clientAction: z.object({
          type: z.literal('prepare_dharma_share_text'),
          title: z.string(),
          text: z.string(),
        }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, text }) =>
      textToolResult(`Prepared "${title}" for user confirmation in the Fabushi app.`, {
        clientAction: {
          type: 'prepare_dharma_share_text',
          title: safeUserText(title).slice(0, 120),
          text: String(text || '').trim().slice(0, 20000),
        },
      }),
  );

  server.registerTool(
    'prepare_practice_book_item',
    {
      title: 'Prepare practice book item',
      description:
        'Prepare a scripture, chant, or practice item for the Fabushi app practice book. This returns a clientAction; it does not mutate the app by itself.',
      inputSchema: {
        title: z.string().min(1).max(120),
        sourceName: z.string().max(120).optional(),
        text: z.string().min(1).max(20000),
      },
      outputSchema: {
        clientAction: z.object({
          type: z.literal('prepare_practice_book_item'),
          title: z.string(),
          sourceName: z.string(),
          text: z.string(),
        }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, sourceName, text }) =>
      textToolResult(`Prepared "${title}" for the Fabushi practice book confirmation flow.`, {
        clientAction: {
          type: 'prepare_practice_book_item',
          title: safeUserText(title).slice(0, 120),
          sourceName: safeUserText(sourceName || '大乘 AI').slice(0, 120),
          text: String(text || '').trim().slice(0, 20000),
        },
      }),
  );

  return server;
}

async function handleMcpRequest(req, res) {
  const server = createLibreChatMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

app.all('/mcp', async (req, res) => {
  try {
    await handleMcpRequest(req, res);
  } catch (error) {
    logger.error({ error: error.stack || String(error) }, 'MCP request failed');
    if (!res.headersSent) {
      res.status(500).json({
        error: 'MCP request failed',
        message: publicAiErrorMessage(error),
      });
    }
  }
});

app.post(
  '/api/resources/download',
  asyncHandler(async (req, res) => {
    const user = await resolveUser(req, req.body || {});
    const cbeta = parseCbetaResource(req.body || {});
    const internetArchive = parseInternetArchiveResource(req.body || {});
    const content = cbeta
      ? await downloadCbetaResource({ ...req.body, ...cbeta })
      : internetArchive
        ? await downloadInternetArchiveAudio({ ...req.body, ...internetArchive })
        : await downloadWebResource(req.body || {});
    const persisted = persistDownloadedResource(user, content);
    const { binaryContent: _binaryContent, ...publicContent } = content;
    jsonResponse(res, 200, {
      success: true,
      downloadId: persisted.id,
      ...publicContent,
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
    const codexRuntime = createCodexDeepSeekRuntime();
    const codex = new Codex(codexRuntime.enabled ? codexRuntime.options : {});
    const thread = codex.startThread(
      codexRuntime.enabled
        ? codexRuntime.threadOptions
        : { skipGitRepoCheck: true, networkAccessEnabled: true },
    );
    const result = await thread.run(prompt);
    jsonResponse(res, 200, {
      success: true,
      threadId: thread.id,
      provider: codexRuntime.provider,
      model: deepseekModel,
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
