function readText(value, max = 512) {
  const text = String(value ?? "").trim();
  return text.length > 0 && text.length <= max ? text : "";
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = [...allowed].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function enrollmentError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = status;
  return error;
}

function validateBrokerUrl(raw) {
  const value = readText(raw, 2048).replace(/\/+$/, "");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw enrollmentError("fdn_enrollment_broker_url_invalid", 503);
  }
  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1");
  if (url.protocol !== "https:" && !loopback) {
    throw enrollmentError("fdn_enrollment_broker_url_invalid", 503);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw enrollmentError("fdn_enrollment_broker_url_invalid", 503);
  }
  return url.origin + url.pathname.replace(/\/$/, "");
}

function validateBrokerToken(raw) {
  const token = readText(raw, 2048);
  if (token.length < 48) throw enrollmentError("fdn_enrollment_broker_unconfigured", 503);
  return token;
}

function validateGrantId(value) {
  const grantId = readText(value, 96);
  if (!/^network-enroll-[a-f0-9]{32}$/.test(grantId)) {
    throw enrollmentError("fdn_enrollment_grant_invalid", 400);
  }
  return grantId;
}

function validateStartBody(body) {
  if (!exactKeys(body, ["grantId", "grantSecret"])) {
    throw enrollmentError("fdn_enrollment_request_invalid", 400);
  }
  const grantId = validateGrantId(body.grantId);
  const grantSecret = readText(body.grantSecret, 512);
  if (grantSecret.length < 80) throw enrollmentError("fdn_enrollment_grant_invalid", 400);
  return { grantId, grantSecret };
}

function validateCompleteBody(body) {
  if (!exactKeys(body, ["grantId"])) {
    throw enrollmentError("fdn_enrollment_request_invalid", 400);
  }
  return { grantId: validateGrantId(body.grantId) };
}

export class FdnEnrollmentBrokerClient {
  constructor({
    baseUrl = process.env.FABUSHI_FDN_ENROLLMENT_BROKER_URL,
    token = process.env.FABUSHI_FDN_ENROLLMENT_BROKER_TOKEN,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
  } = {}) {
    this.baseUrl = validateBrokerUrl(baseUrl);
    this.token = validateBrokerToken(token);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async call(action, body) {
    let response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/v1/internal/fdn/enrollment/${action}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw enrollmentError("fdn_enrollment_broker_unavailable", 503);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw enrollmentError("fdn_enrollment_broker_invalid_response", 502);
    }
    if (!response.ok || payload?.ok !== true) {
      const code = readText(payload?.error?.code, 120) || "fdn_enrollment_broker_rejected";
      const error = enrollmentError(code, response.status >= 400 && response.status < 600 ? response.status : 502);
      error.recoverable = payload?.error?.recoverable !== false;
      throw error;
    }
    return payload;
  }

  start(body) {
    return this.call("start", validateStartBody(body));
  }

  complete(body) {
    return this.call("complete", validateCompleteBody(body));
  }
}

export function authorizeEnrollmentForAccount(user, payload) {
  const canonicalAccountId = readText(user?.fabushiAccountId, 256);
  if (!user?.isAuthenticated || !canonicalAccountId) {
    throw enrollmentError("fdn_enrollment_auth_required", 401);
  }
  const target = payload?.target;
  const enrollment = payload?.enrollment;
  if (!target || typeof target !== "object" || !enrollment || typeof enrollment !== "object") {
    throw enrollmentError("fdn_enrollment_broker_invalid_response", 502);
  }
  if (target.userId !== canonicalAccountId) {
    throw enrollmentError("fdn_enrollment_account_mismatch", 403);
  }
  if (!readText(target.deviceId, 128) || !readText(target.cellId, 128) ||
      !Number.isSafeInteger(Number(target.generation)) || Number(target.generation) < 1) {
    throw enrollmentError("fdn_enrollment_broker_invalid_response", 502);
  }
  if (Number(enrollment.generation) !== Number(target.generation)) {
    throw enrollmentError("fdn_enrollment_generation_mismatch", 502);
  }
  return {
    ...enrollment,
    deviceId: target.deviceId,
  };
}

function send(res, status, body) {
  res.set("cache-control", "no-store");
  return res.status(status).json(body);
}

function routeError(res, error) {
  const status = Number(error?.statusCode);
  const safeStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
  return send(res, safeStatus, {
    ok: false,
    error: {
      code: readText(error?.code, 120) || "fdn_enrollment_failed",
      recoverable: error?.recoverable !== false && safeStatus >= 500,
    },
  });
}

export function registerFdnEnrollmentProxy({
  app,
  resolveUser,
  asyncHandler,
  clientFactory = () => new FdnEnrollmentBrokerClient(),
}) {
  app.post(
    "/api/fdn/network-enrollment/start",
    asyncHandler(async (req, res) => {
      try {
        const user = await resolveUser(req, {});
        if (!user?.isAuthenticated) throw enrollmentError("fdn_enrollment_auth_required", 401);
        const payload = await clientFactory().start(req.body);
        const enrollment = authorizeEnrollmentForAccount(user, payload);
        return send(res, 200, { ok: true, enrollment });
      } catch (error) {
        return routeError(res, error);
      }
    }),
  );

  app.post(
    "/api/fdn/network-enrollment/complete",
    asyncHandler(async (req, res) => {
      try {
        const user = await resolveUser(req, {});
        if (!user?.isAuthenticated) throw enrollmentError("fdn_enrollment_auth_required", 401);
        const payload = await clientFactory().complete(req.body);
        const enrollment = authorizeEnrollmentForAccount(user, payload);
        return send(res, 200, { ok: true, enrollment });
      } catch (error) {
        return routeError(res, error);
      }
    }),
  );
}
