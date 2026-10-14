import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_TOKEN_CHARS = 16 * 1024;

export class FabushiAccountAuthError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "FabushiAccountAuthError";
    this.code = code;
    this.status = status;
  }
}

export function normalizeFabushiApiBaseUrl(value) {
  const parsed = new URL(String(value || "https://api.ombhrum.com"));
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if ((!local && parsed.protocol !== "https:") || (local && !["http:", "https:"].includes(parsed.protocol))) {
    throw new FabushiAccountAuthError("invalid_api_base_url", "Fabushi API must use HTTPS outside loopback.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new FabushiAccountAuthError("invalid_api_base_url", "Fabushi API URL must not contain credentials, query, or fragment data.");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function tokenCacheKey(token) {
  return createHash("sha256").update("fabushi-account-token\0").update(token).digest("base64url");
}

function accountFromUserInfo(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    throw new FabushiAccountAuthError("invalid_user_info", "Fabushi account response is invalid.");
  }
  const userId = String(user.id ?? user.userId ?? "").trim();
  if (!userId || userId.length > 200) {
    throw new FabushiAccountAuthError("invalid_user_info", "Fabushi account response has no stable user id.");
  }
  const label = String(user.nickname ?? user.username ?? user.email ?? userId).trim().slice(0, 200) || userId;
  return { userId, label, user };
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new FabushiAccountAuthError("invalid_json", "Fabushi account service returned invalid JSON.", response.status);
  }
}

export function createFabushiAccountClient(options = {}) {
  const baseUrl = normalizeFabushiApiBaseUrl(options.baseUrl ?? process.env.FABUSHI_API_BASE_URL);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.max(1_000, Math.min(Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS), 60_000));
  const cacheTtlMs = Math.max(0, Math.min(Number(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS), 5 * 60_000));
  const now = options.now ?? Date.now;
  const cache = new Map();
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const payload = await responseJson(response);
      if (!response.ok) {
        const errorCode = String(payload?.error?.code ?? payload?.code ?? `http_${response.status}`);
        const message = String(payload?.error?.message ?? payload?.message ?? "Fabushi account request failed.");
        throw new FabushiAccountAuthError(errorCode, message, response.status);
      }
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new FabushiAccountAuthError("account_request_timeout", "Fabushi account request timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl,

    async resolveAccessToken(token) {
      const normalized = String(token || "").trim();
      if (normalized.length < 24 || normalized.length > MAX_TOKEN_CHARS || /[\r\n]/u.test(normalized)) {
        throw new FabushiAccountAuthError("invalid_account_token", "Fabushi account token is invalid.", 401);
      }
      const key = tokenCacheKey(normalized);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return cached.account;
      const user = await request("/api/auth/user-info", {
        method: "GET",
        headers: { Authorization: `Bearer ${normalized}` },
      });
      const account = accountFromUserInfo(user);
      if (cacheTtlMs > 0) cache.set(key, { account, expiresAt: now() + cacheTtlMs });
      return account;
    },

    async startBrowserLogin({ deviceId, platform = "web" } = {}) {
      const normalizedDeviceId = String(deviceId || `mcp-${Date.now()}`).trim().slice(0, 200);
      const payload = await request("/api/auth/browser/start", {
        method: "POST",
        body: JSON.stringify({ deviceId: normalizedDeviceId, platform }),
      });
      const attemptId = String(payload.attemptId || "");
      const loginUrl = String(payload.loginUrl || "");
      const pollSecret = String(payload.pollSecret || "");
      if (!attemptId || !pollSecret || !/^https:\/\//u.test(loginUrl)) {
        throw new FabushiAccountAuthError("invalid_browser_login", "Fabushi browser login response is incomplete.");
      }
      return {
        attemptId,
        loginUrl,
        pollSecret,
        expiresAt: Number(payload.expiresAt || 0),
        pollAfterMs: Math.max(250, Math.min(Number(payload.pollAfterMs || 750), 5_000)),
      };
    },

    async pollBrowserLogin(attemptId, pollSecret) {
      const safeAttemptId = encodeURIComponent(String(attemptId || ""));
      if (!safeAttemptId || !pollSecret) {
        throw new FabushiAccountAuthError("invalid_browser_poll", "Fabushi browser login poll is invalid.");
      }
      return request(`/api/auth/browser/attempts/${safeAttemptId}`, {
        method: "POST",
        body: JSON.stringify({ pollSecret }),
      });
    },

    clearCache() {
      cache.clear();
    },
  };
}
