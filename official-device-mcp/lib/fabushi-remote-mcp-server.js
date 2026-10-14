import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { attachDeviceGateway, registerDeviceTools } from "./device-gateway.js";
import { createFabushiAccountClient } from "./fabushi-account-auth.js";
import { DEVICE_DISK_SAFETY_INSTRUCTIONS } from "./device-disk-safety.js";

const ACCESS_TOKEN_TTL_SECONDS = 8 * 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  clients: 2_000,
  authorizationRequests: 500,
  codes: 500,
  accessTokens: 5_000,
  refreshTokens: 5_000,
});
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMITS = Object.freeze({
  register: 30,
  authorize: 60,
  poll: 900,
  token: 180,
});
const MCP_SCOPES = ["devices.read", "devices.control"];
const READ_SECURITY_SCHEMES = [{ type: "oauth2", scopes: ["devices.read"] }];
const WRITE_SECURITY_SCHEMES = [{ type: "oauth2", scopes: ["devices.control"] }];

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function safeAccountRef(accountId) {
  return sha256Base64Url(`fabushi-account-audit\0${accountId}`).slice(0, 20);
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function validRedirectUri(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return Boolean(url.hostname);
    if (url.protocol === "http:") return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase());
    return /^[a-z][a-z0-9+.-]*:$/u.test(url.protocol) && !["javascript:", "data:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function normalizePath(value, fallback) {
  const path = String(value || fallback).trim();
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.includes("//")) {
    throw new Error(`Invalid HTTP path: ${path}`);
  }
  return path.replace(/\/$/u, "") || "/";
}

async function readBody(request, maxBytes = MAX_REQUEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function writeHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(html);
}

function requestOrigin(request, configuredOrigin = "") {
  if (configuredOrigin) return configuredOrigin.replace(/\/$/u, "");
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(request.headers.host || "127.0.0.1");
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(host);
  const protocol = forwardedProto || (loopback ? "http" : "https");
  return `${protocol}://${host}`;
}

function bearerToken(request) {
  const authorization = String(request.headers.authorization || "");
  return authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
}

function parseScopes(value) {
  const requested = String(value || "").split(/\s+/u).filter(Boolean);
  const scopes = requested.length ? requested : MCP_SCOPES;
  if (scopes.some((scope) => !MCP_SCOPES.includes(scope))) return null;
  return [...new Set(scopes)];
}

function normalizePublicOrigin(value) {
  if (!value) return "";
  const url = new URL(String(value));
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((!loopback && url.protocol !== "https:") || (loopback && !["http:", "https:"].includes(url.protocol))) {
    throw new Error("FABUSHI_REMOTE_MCP_PUBLIC_ORIGIN must use HTTPS outside loopback.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("FABUSHI_REMOTE_MCP_PUBLIC_ORIGIN must be a clean origin.");
  }
  return url.origin;
}

function oauthMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: MCP_SCOPES,
  };
}

function protectedResourceMetadata(origin, mcpPath) {
  return {
    resource: `${origin}${mcpPath}`,
    authorization_servers: [origin],
    scopes_supported: MCP_SCOPES,
    resource_documentation: "https://github.com/bhrumom/fabushi",
  };
}

function oauthChallenge(origin, mcpPath, scope = "devices.read devices.control") {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${mcpPath}", scope="${scope}"`;
}

function authorizationPage({ requestId, loginUrl, accountLabel = "Fabushi 账号" }) {
  const safeRequestId = htmlEscape(requestId);
  const safeLoginUrl = htmlEscape(loginUrl);
  const safeAccountLabel = htmlEscape(accountLabel);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 Fabushi 设备 MCP</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0e;color:#f5f5f2;font-family:system-ui,-apple-system,sans-serif;padding:24px}.card{width:min(560px,100%);padding:30px;border:1px solid #29292f;border-radius:20px;background:#151519;box-shadow:0 26px 90px #0008}h1{font-size:24px;margin:0 0 12px}p{color:#aaaab2;line-height:1.65}.scope{padding:14px 16px;border-radius:12px;background:#0d0d10;border:1px solid #25252b;color:#d7d7dc;font-size:14px}.button{display:inline-flex;margin-top:20px;padding:12px 18px;border-radius:10px;background:#f4f4f1;color:#111;text-decoration:none;font-weight:750}.status{min-height:24px;margin-top:18px;color:#9f91ff;font-size:13px}.error{color:#ff9aa7}</style></head>
<body><main class="card" data-request-id="${safeRequestId}"><h1>连接 Fabushi 设备 MCP</h1><p>请使用 <strong>${safeAccountLabel}</strong> 登录。授权后，ChatGPT 只能发现并控制同一 Fabushi 账号下当前在线且主动注册的设备，包括临时 GitHub Actions Runner。</p><div class="scope">权限：读取设备状态；向所选设备调用其明确公布的电脑控制工具。Runner 会话到期或工作流结束后自动离线。</div><a class="button" href="${safeLoginUrl}" target="_blank" rel="noopener noreferrer">打开 Fabushi 登录并授权</a><div id="status" class="status">完成登录后，本页会自动返回 ChatGPT。</div></main>
<script>const requestId=${JSON.stringify(requestId)};const status=document.getElementById('status');async function poll(){try{const response=await fetch('/oauth/fabushi/status?request_id='+encodeURIComponent(requestId),{headers:{accept:'application/json'},cache:'no-store'});const result=await response.json();if(result.status==='completed'&&result.redirectUrl){status.textContent='授权完成，正在返回 ChatGPT…';location.replace(result.redirectUrl);return}if(['failed','expired','cancelled'].includes(result.status)){status.className='status error';status.textContent=result.message||'授权未完成，请返回 ChatGPT 重试。';return}}catch{}setTimeout(poll,900)}setTimeout(poll,600);</script></body></html>`;
}

function authorizationCompletionPage(requestId) {
  const safeRequestId = htmlEscape(requestId);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fabushi MCP 授权</title></head><body><main data-request-id="${safeRequestId}">Fabushi 登录完成，正在返回 AI 客户端…</main><script>const requestId=${JSON.stringify(requestId)};async function finish(){try{const response=await fetch('/oauth/fabushi/status?request_id='+encodeURIComponent(requestId),{headers:{accept:'application/json'},cache:'no-store'});const result=await response.json();if(result.status==='completed'&&result.redirectUrl){location.replace(result.redirectUrl);return}if(['failed','expired','cancelled'].includes(result.status)){document.body.textContent=result.message||'Fabushi 授权未完成，请返回 AI 客户端重试。';return}}catch{}setTimeout(finish,500)}finish();</script></body></html>`;
}

function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clientAddress(request) {
  const cloudflare = String(request.headers["cf-connecting-ip"] || "").trim();
  if (cloudflare) return cloudflare.slice(0, 128);
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || request.socket.remoteAddress || "unknown").slice(0, 128);
}

function trimMapToLimit(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function normalizeStatePayload(payload) {
  const output = { clients: [], accessTokens: [], refreshTokens: [] };
  for (const client of payload?.clients ?? []) {
    const clientId = String(client?.clientId || "");
    const redirectUris = Array.isArray(client?.redirectUris) ? client.redirectUris.map(String).filter(validRedirectUri) : [];
    if (clientId && redirectUris.length) output.clients.push({ clientId, redirectUris, createdAt: Number(client?.createdAt || 0) });
  }
  const now = Date.now();
  for (const token of payload?.accessTokens ?? []) {
    const expiresAt = Number(token?.expiresAt || 0);
    if (!token?.token || !token?.accountId || expiresAt <= now) continue;
    output.accessTokens.push({
      token: String(token.token), accountId: String(token.accountId), accountLabel: String(token.accountLabel || ""),
      clientId: String(token.clientId || ""), resource: String(token.resource || ""), scopes: Array.isArray(token.scopes) ? token.scopes.filter((scope) => MCP_SCOPES.includes(scope)) : [],
      createdAt: Number(token.createdAt || now), expiresAt,
    });
  }
  for (const token of payload?.refreshTokens ?? []) {
    const expiresAt = Number(token?.expiresAt || 0);
    if (!token?.token || !token?.accountId || expiresAt <= now) continue;
    output.refreshTokens.push({
      token: String(token.token), accountId: String(token.accountId), accountLabel: String(token.accountLabel || ""),
      clientId: String(token.clientId || ""), resource: String(token.resource || ""), scopes: Array.isArray(token.scopes) ? token.scopes.filter((scope) => MCP_SCOPES.includes(scope)) : [],
      createdAt: Number(token.createdAt || now), expiresAt,
    });
  }
  return output;
}

export function createFabushiRemoteMcpServer(options = {}) {
  const host = String(options.host ?? process.env.FABUSHI_REMOTE_MCP_HOST ?? "127.0.0.1");
  const requestedPort = Number(options.port ?? process.env.PORT ?? process.env.FABUSHI_REMOTE_MCP_PORT ?? 8790);
  const mcpPath = normalizePath(options.mcpPath ?? process.env.MCP_PATH_PREFIX, "/mcp");
  const agentPath = normalizePath(options.agentPath ?? process.env.DEVICE_GATEWAY_PATH, "/agent");
  const browserAgentPath = normalizePath(options.browserAgentPath ?? process.env.DEVICE_BROWSER_GATEWAY_PATH, "/browser-agent");
  const publicOrigin = normalizePublicOrigin(options.publicOrigin ?? process.env.FABUSHI_REMOTE_MCP_PUBLIC_ORIGIN ?? "");
  const statePath = options.statePath ?? process.env.FABUSHI_REMOTE_MCP_STATE_PATH ?? resolve(homedir(), ".fabushi", "remote-mcp-state.json");
  const auditPath = options.auditPath ?? process.env.FABUSHI_REMOTE_MCP_AUDIT_PATH ?? resolve(homedir(), ".fabushi", "remote-mcp-audit.jsonl");
  const accountClient = options.accountClient ?? createFabushiAccountClient({ baseUrl: options.apiBaseUrl });
  const now = options.now ?? Date.now;
  const limits = {
    clients: positiveLimit(options.limits?.clients, DEFAULT_LIMITS.clients),
    authorizationRequests: positiveLimit(options.limits?.authorizationRequests, DEFAULT_LIMITS.authorizationRequests),
    codes: positiveLimit(options.limits?.codes, DEFAULT_LIMITS.codes),
    accessTokens: positiveLimit(options.limits?.accessTokens, DEFAULT_LIMITS.accessTokens),
    refreshTokens: positiveLimit(options.limits?.refreshTokens, DEFAULT_LIMITS.refreshTokens),
  };
  const clients = new Map();
  const authorizationRequests = new Map();
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const rateBuckets = new Map();
  let saveChain = Promise.resolve();
  let loaded = false;
  let listening = false;
  let gateway = null;

  async function audit(record) {
    const safe = { at: new Date(now()).toISOString(), ...record };
    if (options.audit) options.audit(safe);
    if (!auditPath) return;
    await mkdir(dirname(auditPath), { recursive: true });
    await appendFile(auditPath, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async function loadState() {
    if (loaded) return;
    loaded = true;
    let payload = {};
    if (statePath) {
      try { payload = JSON.parse(await readFile(statePath, "utf8")); } catch {}
    }
    const normalized = normalizeStatePayload(payload);
    for (const client of normalized.clients.slice(-limits.clients)) clients.set(client.clientId, { redirectUris: client.redirectUris, createdAt: client.createdAt || now() });
    for (const token of normalized.accessTokens.slice(-limits.accessTokens)) accessTokens.set(token.token, token);
    for (const token of normalized.refreshTokens.slice(-limits.refreshTokens)) refreshTokens.set(token.token, token);
  }

  async function saveState() {
    if (!statePath) return;
    const operation = saveChain.then(async () => {
      const payload = {
        version: 1,
        clients: [...clients].map(([clientId, value]) => ({ clientId, redirectUris: value.redirectUris, createdAt: value.createdAt })),
        accessTokens: [...accessTokens.values()],
        refreshTokens: [...refreshTokens.values()],
      };
      await mkdir(dirname(statePath), { recursive: true });
      const temporary = `${statePath}.${process.pid}.${now()}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, statePath);
    });
    saveChain = operation.catch(() => {});
    return operation;
  }

  function cleanupExpired() {
    const timestamp = now();
    for (const [id, value] of authorizationRequests) if (value.expiresAt <= timestamp) authorizationRequests.delete(id);
    for (const [id, value] of codes) if (value.expiresAt <= timestamp) codes.delete(id);
    let changed = false;
    for (const [token, value] of accessTokens) if (value.expiresAt <= timestamp) { accessTokens.delete(token); changed = true; }
    for (const [token, value] of refreshTokens) if (value.expiresAt <= timestamp) { refreshTokens.delete(token); changed = true; }
    for (const [key, value] of rateBuckets) if (value.resetAt <= timestamp) rateBuckets.delete(key);
    if (changed) void saveState();
  }

  function consumeRateLimit(request, namespace, limit) {
    const timestamp = now();
    const key = `${namespace}:${clientAddress(request)}`;
    const current = rateBuckets.get(key);
    if (!current || current.resetAt <= timestamp) {
      rateBuckets.set(key, { count: 1, resetAt: timestamp + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  function originFor(request) {
    return requestOrigin(request, publicOrigin);
  }

  function resourceFor(request) {
    return `${originFor(request)}${mcpPath}`;
  }

  function authorizationFor(request) {
    cleanupExpired();
    const token = bearerToken(request);
    const entry = accessTokens.get(token);
    if (!entry || entry.expiresAt <= now() || (entry.resource && entry.resource !== resourceFor(request))) return null;
    return entry;
  }

  async function registerOAuthClient(request, response) {
    if (!consumeRateLimit(request, "register", RATE_LIMITS.register)) return writeJson(response, 429, { error: "slow_down" }, { "retry-after": "600" });
    if (clients.size >= limits.clients) return writeJson(response, 503, { error: "temporarily_unavailable" });
    let payload;
    try { payload = JSON.parse(await readBody(request) || "{}"); } catch { return writeJson(response, 400, { error: "invalid_client_metadata" }); }
    const redirectUris = Array.isArray(payload.redirect_uris) ? [...new Set(payload.redirect_uris.map(String))] : [];
    if (!redirectUris.length || redirectUris.length > 16 || redirectUris.some((uri) => !validRedirectUri(uri))) {
      return writeJson(response, 400, { error: "invalid_redirect_uri" });
    }
    const clientId = `fabushi_${randomToken(24)}`;
    clients.set(clientId, { redirectUris, createdAt: now() });
    await saveState();
    writeJson(response, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      client_id_expires_at: 0,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  async function beginAuthorization(request, response, url) {
    if (!consumeRateLimit(request, "authorize", RATE_LIMITS.authorize)) return writeJson(response, 429, { error: "slow_down" }, { "retry-after": "600" });
    if (authorizationRequests.size >= limits.authorizationRequests) return writeJson(response, 503, { error: "temporarily_unavailable" });
    const clientId = url.searchParams.get("client_id") || "";
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const state = url.searchParams.get("state") || "";
    const responseType = url.searchParams.get("response_type") || "";
    const challenge = url.searchParams.get("code_challenge") || "";
    const challengeMethod = url.searchParams.get("code_challenge_method") || "";
    const resource = url.searchParams.get("resource") || resourceFor(request);
    const scopes = parseScopes(url.searchParams.get("scope"));
    const client = clients.get(clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) return writeJson(response, 400, { error: "invalid_client" });
    if (!state || responseType !== "code") return writeJson(response, 400, { error: "invalid_request" });
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(challenge) || challengeMethod !== "S256") return writeJson(response, 400, { error: "invalid_request", error_description: "PKCE S256 is required" });
    if (!scopes) return writeJson(response, 400, { error: "invalid_scope" });
    if (resource !== resourceFor(request)) return writeJson(response, 400, { error: "invalid_target" });

    const requestId = randomToken(32);
    const started = await accountClient.startBrowserLogin({ deviceId: `mcp-oauth-${requestId}`, platform: "web" });
    authorizationRequests.set(requestId, {
      requestId, clientId, redirectUri, state, codeChallenge: challenge, codeChallengeMethod: challengeMethod,
      resource, scopes, attemptId: started.attemptId, pollSecret: started.pollSecret,
      expiresAt: Math.min(now() + AUTHORIZATION_TTL_MS, started.expiresAt ? started.expiresAt * 1000 : Number.MAX_SAFE_INTEGER),
    });
    await audit({ type: "oauth.authorization.started", clientId: sha256Base64Url(clientId).slice(0, 16) });
    response.writeHead(302, {
      location: started.loginUrl,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end();
  }

  async function pollAuthorization(request, response, url) {
    if (!consumeRateLimit(request, "poll", RATE_LIMITS.poll)) return writeJson(response, 429, { status: "pending", message: "授权轮询过于频繁。" }, { "retry-after": "60" });
    cleanupExpired();
    const requestId = url.searchParams.get("request_id") || "";
    const pending = authorizationRequests.get(requestId);
    if (!pending) return writeJson(response, 404, { status: "expired", message: "授权请求已失效，请返回 ChatGPT 重试。" });
    let result;
    try { result = await accountClient.pollBrowserLogin(pending.attemptId, pending.pollSecret); }
    catch (error) { return writeJson(response, 200, { status: "pending", message: error instanceof Error ? error.message : "登录状态暂不可用" }); }
    const status = String(result?.status || "pending");
    if (status !== "completed") {
      if (["failed", "expired", "cancelled"].includes(status)) authorizationRequests.delete(requestId);
      return writeJson(response, 200, { status, message: status === "pending" ? "等待 Fabushi 登录完成" : "Fabushi 登录未完成" });
    }
    const accountAccessToken = String(result?.session?.accessToken || "");
    if (!accountAccessToken) {
      authorizationRequests.delete(requestId);
      return writeJson(response, 200, { status: "failed", message: "Fabushi 登录结果缺少账号凭证。" });
    }
    let account;
    try { account = await accountClient.resolveAccessToken(accountAccessToken); }
    catch {
      authorizationRequests.delete(requestId);
      return writeJson(response, 200, { status: "failed", message: "无法验证 Fabushi 账号，请重新授权。" });
    }
    if (codes.size >= limits.codes) {
      authorizationRequests.delete(requestId);
      return writeJson(response, 503, { status: "failed", message: "授权服务暂时繁忙，请稍后重试。" });
    }
    const code = randomToken(32);
    codes.set(code, {
      clientId: pending.clientId, redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod, resource: pending.resource, scopes: pending.scopes,
      accountId: account.userId, accountLabel: account.label, expiresAt: now() + CODE_TTL_MS,
    });
    authorizationRequests.delete(requestId);
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", pending.state);
    await audit({ type: "oauth.authorization.completed", accountRef: safeAccountRef(account.userId), clientId: sha256Base64Url(pending.clientId).slice(0, 16) });
    writeJson(response, 200, { status: "completed", redirectUrl: redirect.href });
  }

  async function exchangeToken(request, response) {
    if (!consumeRateLimit(request, "token", RATE_LIMITS.token)) return writeJson(response, 429, { error: "slow_down" }, { "retry-after": "600" });
    let params;
    try {
      const contentType = String(request.headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("application/x-www-form-urlencoded")) return writeJson(response, 415, { error: "invalid_request" });
      params = new URLSearchParams(await readBody(request));
    } catch { return writeJson(response, 400, { error: "invalid_request" }); }
    cleanupExpired();
    const grantType = params.get("grant_type") || "";
    const clientId = params.get("client_id") || "";
    if (!clients.has(clientId)) return writeJson(response, 400, { error: "invalid_client" });

    let source;
    if (grantType === "authorization_code") {
      const code = params.get("code") || "";
      source = codes.get(code);
      if (!source || source.clientId !== clientId || source.redirectUri !== (params.get("redirect_uri") || "")) return writeJson(response, 400, { error: "invalid_grant" });
      const verifier = params.get("code_verifier") || "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) || sha256Base64Url(verifier) !== source.codeChallenge) return writeJson(response, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      const resource = params.get("resource") || source.resource;
      if (resource !== source.resource) return writeJson(response, 400, { error: "invalid_target" });
      codes.delete(code);
    } else if (grantType === "refresh_token") {
      const refreshToken = params.get("refresh_token") || "";
      source = refreshTokens.get(refreshToken);
      if (!source || source.clientId !== clientId || source.expiresAt <= now()) return writeJson(response, 400, { error: "invalid_grant" });
      const resource = params.get("resource") || source.resource;
      if (resource !== source.resource) return writeJson(response, 400, { error: "invalid_target" });
      refreshTokens.delete(refreshToken);
    } else {
      return writeJson(response, 400, { error: "unsupported_grant_type" });
    }

    const timestamp = now();
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const accessEntry = {
      token: accessToken, accountId: source.accountId, accountLabel: source.accountLabel,
      clientId, resource: source.resource, scopes: source.scopes, createdAt: timestamp,
      expiresAt: timestamp + ACCESS_TOKEN_TTL_SECONDS * 1000,
    };
    const refreshEntry = {
      token: refreshToken, accountId: source.accountId, accountLabel: source.accountLabel,
      clientId, resource: source.resource, scopes: source.scopes, createdAt: timestamp,
      expiresAt: timestamp + REFRESH_TOKEN_TTL_SECONDS * 1000,
    };
    accessTokens.set(accessToken, accessEntry);
    refreshTokens.set(refreshToken, refreshEntry);
    trimMapToLimit(accessTokens, limits.accessTokens);
    trimMapToLimit(refreshTokens, limits.refreshTokens);
    await saveState();
    await audit({ type: "oauth.token.issued", accountRef: safeAccountRef(source.accountId), clientId: sha256Base64Url(clientId).slice(0, 16), grantType });
    writeJson(response, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: source.scopes.join(" "),
    });
  }

  function createMcp(account) {
    const server = new McpServer({ name: "fabushi-device-control", version: "1.0.0" }, { instructions: DEVICE_DISK_SAFETY_INSTRUCTIONS });
    server.registerTool("fabushi_account", {
      title: "Current Fabushi account",
      description: "Return the Fabushi account identity that scopes device discovery for this MCP connection.",
      inputSchema: {},
      outputSchema: { accountId: z.string(), accountLabel: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      securitySchemes: READ_SECURITY_SCHEMES,
    }, async () => ({
      structuredContent: { accountId: account.accountId, accountLabel: account.accountLabel },
      content: [{ type: "text", text: `Connected to Fabushi account ${account.accountLabel || account.accountId}.` }],
    }));
    const readAllowed = account.scopes.includes("devices.read");
    const writeAllowed = account.scopes.includes("devices.control");
    const authError = (scope) => ({
      isError: true,
      content: [{ type: "text", text: `The Fabushi MCP token does not grant ${scope}.` }],
    });
    registerDeviceTools(server, {
      accountId: account.accountId,
      canRead: () => readAllowed,
      canWrite: () => writeAllowed,
      readAuthError: () => authError("devices.read"),
      writeAuthError: () => authError("devices.control"),
      readSecuritySchemes: READ_SECURITY_SCHEMES,
      writeSecuritySchemes: WRITE_SECURITY_SCHEMES,
    });
    return server;
  }

  const httpServer = createServer(async (request, response) => {
    try {
      await loadState();
      cleanupExpired();
      const origin = originFor(request);
      const url = new URL(request.url || "/", origin);
      if (request.method === "OPTIONS" && (url.pathname === mcpPath || url.pathname.startsWith("/oauth/"))) {
        response.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "Authorization,Content-Type,Mcp-Session-Id",
          "access-control-expose-headers": "Mcp-Session-Id,WWW-Authenticate",
        });
        return response.end();
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return response.end("Fabushi account-scoped device-control MCP. Add the /mcp URL to ChatGPT.");
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return writeJson(response, 200, { ok: true, service: "fabushi-device-control-mcp", mcpPath, agentPath });
      }
      if (request.method === "GET" && (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")) {
        return writeJson(response, 200, oauthMetadata(origin));
      }
      if (request.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === `/.well-known/oauth-protected-resource${mcpPath}`)) {
        return writeJson(response, 200, protectedResourceMetadata(origin, mcpPath));
      }
      if (request.method === "POST" && url.pathname === "/oauth/register") return registerOAuthClient(request, response);
      if (request.method === "GET" && url.pathname === "/oauth/authorize") return beginAuthorization(request, response, url);
      if (request.method === "GET" && url.pathname === "/oauth/fabushi/complete") {
        const requestId = url.searchParams.get("request_id") || "";
        if (!/^[A-Za-z0-9_-]{32,128}$/u.test(requestId) || !authorizationRequests.has(requestId)) {
          return writeJson(response, 400, { error: "invalid_request", error_description: "Fabushi authorization request is missing or expired." });
        }
        return writeHtml(response, authorizationCompletionPage(requestId));
      }
      if (request.method === "GET" && url.pathname === "/oauth/fabushi/status") return pollAuthorization(request, response, url);
      if (request.method === "POST" && url.pathname === "/oauth/token") return exchangeToken(request, response);
      if (url.pathname === mcpPath && ["GET", "POST", "DELETE"].includes(request.method || "")) {
        const account = authorizationFor(request);
        if (!account) {
          return writeJson(response, 401, { error: "unauthorized", error_description: "Authorize ChatGPT with a Fabushi account." }, {
            "www-authenticate": oauthChallenge(origin, mcpPath),
            "access-control-allow-origin": "*",
            "access-control-expose-headers": "WWW-Authenticate,Mcp-Session-Id",
          });
        }
        const mcp = createMcp(account);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id,WWW-Authenticate");
        response.on("close", () => { void transport.close(); void mcp.close(); });
        await mcp.connect(transport);
        return transport.handleRequest(request, response);
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not Found");
    } catch (error) {
      await audit({ type: "http.error", message: error instanceof Error ? error.message.slice(0, 500) : "unknown error" }).catch(() => {});
      if (!response.headersSent) writeJson(response, 500, { error: "internal_error" });
      else response.destroy();
    }
  });

  httpServer.maxHeadersCount = 64;
  httpServer.headersTimeout = 15_000;
  httpServer.requestTimeout = 650_000;
  httpServer.keepAliveTimeout = 10_000;

  gateway = attachDeviceGateway(httpServer, {
    path: agentPath,
    browserPath: browserAgentPath,
    browserExtensionId: options.browserExtensionId,
    resolveAccount: (token) => accountClient.resolveAccessToken(token),
    syncHumanCallVoIPDevice: async ({ accessToken, deviceId, token }) => {
      if (!accessToken || !deviceId) throw new Error("missing authenticated device identity");
      const endpoint = new URL("/api/social/calls/voip-device", accountClient.baseUrl);
      const response = await (options.fetchImpl ?? globalThis.fetch)(endpoint, {
        method: token ? "PUT" : "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "x-fabushi-device-id": deviceId,
          ...(token ? { "content-type": "application/json" } : {}),
        },
        ...(token ? { body: JSON.stringify({ token }) } : {}),
      });
      if (!response.ok) {
        throw new Error(`Human Call VoIP device sync failed (HTTP ${response.status})`);
      }
    },
    audit: (record) => void audit({ ...record, accountRef: record.accountId ? safeAccountRef(record.accountId) : undefined, accountId: undefined }),
    defaultLeaseSeconds: Number(options.defaultLeaseSeconds ?? process.env.DEVICE_DEFAULT_LEASE_SECONDS ?? 2 * 60 * 60),
    maxLeaseSeconds: Number(options.maxLeaseSeconds ?? process.env.DEVICE_MAX_LEASE_SECONDS ?? 4 * 60 * 60),
  });

  return {
    host,
    requestedPort,
    mcpPath,
    agentPath,
    browserAgentPath,
    httpServer,
    accountClient,
    async listen() {
      await loadState();
      if (listening) return httpServer.address();
      await new Promise((resolveListen, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(requestedPort, host, () => {
          httpServer.off("error", reject);
          listening = true;
          resolveListen();
        });
      });
      return httpServer.address();
    },
    async close() {
      if (gateway) await gateway.close();
      if (listening) await new Promise((resolveClose) => httpServer.close(resolveClose));
      listening = false;
    },
  };
}
