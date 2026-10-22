import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const TOOL_GRANT_SKEW_SECONDS = 30;

export class CoreDeviceTransportOutcomeUnknownError extends Error {
  constructor(message, requestId) {
    super(message);
    this.name = "CoreDeviceTransportOutcomeUnknownError";
    this.requestId = requestId;
    this.outcomeUnknown = true;
  }
}

function stableId(prefix, ...parts) {
  const digest = createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\0")).digest("hex");
  return `${prefix}-${digest.slice(0, 48)}`;
}

function requiredText(value, field, max = 512) {
  const text = String(value?.[field] ?? "").trim();
  if (!text || text.length > max || /[\r\n]/u.test(text)) {
    throw new Error(`Invalid target ${field}.`);
  }
  return text;
}

function requiredGeneration(value, field = "grantGeneration") {
  const generation = Number(value?.[field]);
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error(`Invalid target ${field}.`);
  return generation;
}

function validateTransport(privateTransport) {
  if (!privateTransport || typeof privateTransport.request !== "function") {
    throw new TypeError("An authenticated private Remote Computer transport is required.");
  }
  return privateTransport;
}

function validateAccountClient(accountClient) {
  for (const method of [
    "getRemoteComputerNetworkRoute",
    "createRemoteComputerSession",
    "reconcileRemoteComputerSession",
    "createRemoteComputerOperation",
    "queryRemoteComputerOperation",
    "markRemoteComputerOperationOutcomeUnknown",
  ]) {
    if (typeof accountClient?.[method] !== "function") {
      throw new TypeError(`Fabushi account client is missing ${method}.`);
    }
  }
  return accountClient;
}

export function createCoreDeviceTransport(options = {}) {
  const accountClient = validateAccountClient(options.accountClient);
  const privateTransport = validateTransport(options.privateTransport);
  const fallbackTransport = options.fallbackTransport ? validateTransport(options.fallbackTransport) : null;
  if (fallbackTransport === privateTransport) throw new TypeError("Primary and fallback private transports must be distinct.");
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  async function resolveNetworkRoute(context) {
    const route = await accountClient.getRemoteComputerNetworkRoute(
      context.coreServiceAccessToken,
      {
        deviceId: context.deviceId,
        connectionId: context.connectionId,
        delegationId: context.delegationId,
      },
    );
    if (!route || route.active !== true
      || String(route.deviceId || "") !== context.deviceId
      || String(route.connectionId || "") !== context.connectionId
      || String(route.delegationId || "") !== context.delegationId
      || !Number.isSafeInteger(Number(route.generation))
      || Number(route.generation) <= 0
      || !Number.isSafeInteger(Number(route.expiresAt))
      || Number(route.expiresAt) <= now()
      || !String(route.cellId || "").trim()
      || !String(route.nodeId || "").trim()) {
      throw new Error("Canonical Core network route failed identity correlation.");
    }
    const generation = Number(route.generation);
    if (context.boundNetworkGeneration == null) {
      context.boundNetworkGeneration = generation;
    } else if (Number(context.boundNetworkGeneration) !== generation) {
      throw new Error("Canonical Core network generation changed during the request.");
    }
    return route;
  }

  async function privateRequest(context, payload, timeoutSeconds, route = null) {
    const currentRoute = route ?? await resolveNetworkRoute(context);
    const makeRequest = (networkRoute) => ({
      accountId: context.accountId,
      deviceId: context.deviceId,
      cellId: networkRoute.cellId,
      nodeId: networkRoute.nodeId,
      networkGeneration: Number(networkRoute.generation),
      networkExpiresAt: Number(networkRoute.expiresAt),
      networkRoute,
      payload,
      timeoutSeconds,
      signal: context.signal,
    });
    let response;
    try {
      response = await privateTransport.request(makeRequest(currentRoute));
    } catch (error) {
      // Fallback is safe only when the primary worker proves that no request bytes
      // were dispatched. Re-resolve Core immediately before the alternate path so
      // expiry, revocation, generation rotation, or binding changes fail closed.
      if (!fallbackTransport
          || error?.notDispatched !== true
          || error?.dispatchState !== "not_dispatched"
          || context.signal?.aborted) throw error;
      const fallbackRoute = await resolveNetworkRoute(context);
      if (context.signal?.aborted) throw error;
      response = await fallbackTransport.request(makeRequest(fallbackRoute));
    }
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Private target transport returned an invalid response.");
    }
    return response;
  }

  async function controllerGrant(context) {
    if (context.computer?.networkBound !== true) {
      throw new Error("Target device has no active canonical network binding.");
    }
    const route = await resolveNetworkRoute(context);
    const networkGeneration = Number(route.generation);
    const grantRequestId = stableId(
      "official-mcp-grant",
      context.accountId,
      context.deviceId,
      context.connectionId,
      context.delegationId,
      networkGeneration,
    );
    const granted = await privateRequest(context, {
      type: "grantController",
      deviceId: context.deviceId,
      networkGeneration,
      connectionId: context.connectionId,
      delegationId: context.delegationId,
      requestId: grantRequestId,
      label: "Fabushi Official MCP",
    }, Math.min(context.timeoutSeconds, 30), route);
    if (granted.type !== "controllerGranted"
      || String(granted.deviceId) !== context.deviceId
      || String(granted.connectionId) !== context.connectionId
      || String(granted.delegationId) !== context.delegationId
      || String(granted.requestId) !== grantRequestId
      || Number(granted.networkGeneration) !== networkGeneration) {
      throw new Error("Target controller grant failed identity correlation.");
    }
    return {
      clientId: requiredText(granted, "clientId", 160),
      clientToken: requiredText(granted, "clientToken", 256),
    };
  }

  async function sessionFor(context, grant) {
    const requestId = stableId(
      "official-mcp-session",
      context.accountId,
      context.deviceId,
      context.connectionId,
      context.delegationId,
      grant.clientId,
    );
    const input = {
      deviceId: context.deviceId,
      clientId: grant.clientId,
      clientToken: grant.clientToken,
      requestId,
    };
    try {
      return await accountClient.createRemoteComputerSession(context.coreServiceAccessToken, input);
    } catch {
      return accountClient.reconcileRemoteComputerSession(context.coreServiceAccessToken, input);
    }
  }

  async function authorizeTool(context, session, grant) {
    const route = await resolveNetworkRoute(context);
    const networkGeneration = Number(route.generation);
    const requestedExpiresAt = now() + Math.min(context.timeoutSeconds + TOOL_GRANT_SKEW_SECONDS, 10 * 60);
    const authorized = await privateRequest(context, {
      type: "authorizeTool",
      deviceId: context.deviceId,
      networkGeneration,
      sessionId: session.sessionId,
      clientId: grant.clientId,
      toolName: context.toolName,
      expiresAt: requestedExpiresAt,
    }, Math.min(context.timeoutSeconds, 30), route);
    if (authorized.type !== "toolAuthorized"
      || String(authorized.deviceId) !== context.deviceId
      || String(authorized.sessionId) !== String(session.sessionId)
      || String(authorized.clientId) !== grant.clientId
      || String(authorized.toolName) !== context.toolName
      || Number(authorized.networkGeneration) !== networkGeneration) {
      throw new Error("Target tool grant failed identity correlation.");
    }
    const expiresAt = Number(authorized.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > requestedExpiresAt) {
      throw new Error("Target tool grant returned an invalid expiry.");
    }
    return requiredGeneration(authorized);
  }

  async function markOutcomeUnknown(context, session, grant, reason) {
    try {
      await accountClient.markRemoteComputerOperationOutcomeUnknown(context.coreServiceAccessToken, {
        deviceId: context.deviceId,
        sessionId: session.sessionId,
        clientId: grant.clientId,
        mobileToken: session.mobileToken,
        requestId: context.requestId,
      });
    } catch {
      // Preserve the caller-visible uncertainty even if Core is temporarily unreachable.
    }
    throw new CoreDeviceTransportOutcomeUnknownError(reason, context.requestId);
  }

  async function describeTool(input = {}) {
    const context = {
      ...input,
      accountId: String(input.accountId || "").trim(),
      deviceId: String(input.deviceId || "").trim(),
      toolName: String(input.toolName || "").trim(),
      connectionId: String(input.connectionId || "").trim(),
      delegationId: String(input.delegationId || "").trim(),
      timeoutSeconds: 30,
    };
    if (!context.accountId || !context.deviceId || !context.toolName
      || !context.connectionId || !context.delegationId) {
      throw new Error("Core Remote Computer tool description context is incomplete.");
    }
    if (context.computer?.online !== true
      || context.computer?.networkBound !== true
      || !Number.isSafeInteger(Number(context.computer?.networkGeneration))
      || Number(context.computer.networkGeneration) <= 0) {
      return {
        deviceId: context.deviceId,
        toolName: context.toolName,
        available: false,
        schemaVersion: "",
        tool: null,
        message: `Device ${context.deviceId} has no active canonical private route.`,
      };
    }
    const route = await resolveNetworkRoute(context);
    const requestId = stableId(
      "official-mcp-describe",
      context.accountId,
      context.deviceId,
      context.connectionId,
      context.delegationId,
      context.toolName,
      route.generation,
    );
    const response = await privateRequest(context, {
      type: "describeTool",
      deviceId: context.deviceId,
      networkGeneration: Number(route.generation),
      connectionId: context.connectionId,
      delegationId: context.delegationId,
      requestId,
      label: "Fabushi Official MCP",
      toolName: context.toolName,
    }, 30, route);
    if (response.type !== "toolDescription"
      || String(response.deviceId) !== context.deviceId
      || String(response.connectionId) !== context.connectionId
      || String(response.delegationId) !== context.delegationId
      || String(response.requestId) !== requestId
      || String(response.toolName) !== context.toolName
      || Number(response.networkGeneration) !== Number(route.generation)
      || typeof response.available !== "boolean") {
      throw new Error("Target tool description failed identity correlation.");
    }
    const schemaVersion = String(response.schemaVersion || "");
    if (schemaVersion && !/^[0-9a-f]{64}$/u.test(schemaVersion)) {
      throw new Error("Target tool description returned an invalid schema version.");
    }
    if (!response.available) {
      if (response.tool != null || schemaVersion) {
        throw new Error("Unavailable target tool description must not carry schema data.");
      }
      return {
        deviceId: context.deviceId,
        toolName: context.toolName,
        available: false,
        schemaVersion: "",
        tool: null,
        message: `Tool ${context.toolName} is not available on ${context.deviceId}.`,
      };
    }
    if (!response.tool || typeof response.tool !== "object" || Array.isArray(response.tool)
      || String(response.tool.name || "") !== context.toolName
      || !schemaVersion) {
      throw new Error("Available target tool description is incomplete.");
    }
    return {
      deviceId: context.deviceId,
      toolName: context.toolName,
      available: true,
      schemaVersion,
      tool: response.tool,
      message: `Returned the target-authorized schema for ${context.toolName} on ${context.deviceId}.`,
    };
  }

  return {
    describeDeviceTool: describeTool,

    async callDevice(input = {}) {
      const timeoutSeconds = Math.min(Math.max(Number(input.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS, 1), MAX_TIMEOUT_SECONDS);
      const context = {
        ...input,
        accountId: String(input.accountId || "").trim(),
        deviceId: String(input.deviceId || "").trim(),
        toolName: String(input.toolName || "").trim(),
        requestId: String(input.requestId || "").trim(),
        requestSha256: String(input.requestSha256 || "").trim(),
        connectionId: String(input.connectionId || "").trim(),
        delegationId: String(input.delegationId || "").trim(),
        coreServiceAccessToken: String(input.coreServiceAccessToken || "").trim(),
        timeoutSeconds,
      };
      if (!context.accountId || !context.deviceId || !context.toolName
        || !/^[A-Za-z0-9._:-]{16,160}$/u.test(context.requestId)
        || !/^[0-9a-f]{64}$/u.test(context.requestSha256)
        || !context.connectionId || !context.delegationId || !context.coreServiceAccessToken) {
        throw new Error("Core Remote Computer call context is incomplete.");
      }
      if (context.computer?.online !== true) throw new Error(`Device ${context.deviceId} is offline in canonical Core inventory.`);

      const grant = await controllerGrant(context);
      const session = await sessionFor(context, grant);
      const grantGeneration = await authorizeTool(context, session, grant);

      const operation = await accountClient.createRemoteComputerOperation(context.coreServiceAccessToken, {
        deviceId: context.deviceId,
        sessionId: session.sessionId,
        clientId: grant.clientId,
        mobileToken: session.mobileToken,
        requestId: context.requestId,
        toolName: context.toolName,
        requestSha256: context.requestSha256,
        sensitiveResult: false,
      });
      if (String(operation.requestId) !== context.requestId
        || String(operation.sessionId) !== String(session.sessionId)
        || String(operation.clientId) !== grant.clientId
        || String(operation.toolName) !== context.toolName
        || String(operation.requestSha256) !== context.requestSha256) {
        throw new Error("Core operation creation failed identity correlation.");
      }

      let targetReply;
      let operationRoute;
      try {
        operationRoute = await resolveNetworkRoute(context);
        targetReply = await privateRequest(context, {
          type: "operation",
          deviceId: context.deviceId,
          networkGeneration: Number(operationRoute.generation),
          sessionId: session.sessionId,
          clientId: grant.clientId,
          requestId: context.requestId,
          toolName: context.toolName,
          requestSha256: context.requestSha256,
          grantGeneration,
          arguments: context.args ?? {},
          diskPreflight: context.diskPreflight ?? {},
        }, timeoutSeconds, operationRoute);
      } catch (error) {
        return markOutcomeUnknown(
          context,
          session,
          grant,
          `Private target transport failed after Core operation creation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (targetReply.status === "outcome_unknown") {
        return markOutcomeUnknown(context, session, grant, "Target reported an unknown execution outcome.");
      }
      if (targetReply.type !== "operationResult"
        || String(targetReply.deviceId) !== context.deviceId
        || String(targetReply.sessionId) !== String(session.sessionId)
        || String(targetReply.requestId) !== context.requestId
        || String(targetReply.requestSha256) !== context.requestSha256
        || Number(targetReply.networkGeneration) !== Number(operationRoute.generation)
        || !["completed", "failed"].includes(String(targetReply.status))) {
        return markOutcomeUnknown(context, session, grant, "Target result failed identity correlation after dispatch.");
      }

      const queried = await accountClient.queryRemoteComputerOperation(context.coreServiceAccessToken, {
        deviceId: context.deviceId,
        sessionId: session.sessionId,
        clientId: grant.clientId,
        mobileToken: session.mobileToken,
        requestId: context.requestId,
      });
      if (String(queried.requestId) !== context.requestId
        || String(queried.sessionId) !== String(session.sessionId)
        || String(queried.clientId) !== grant.clientId
        || String(queried.state) !== String(targetReply.status)) {
        return markOutcomeUnknown(context, session, grant, "Core result query did not confirm the target result.");
      }
      if (targetReply.resultSha256 && String(queried.resultSha256 || "") !== String(targetReply.resultSha256)) {
        return markOutcomeUnknown(context, session, grant, "Core and target result digests do not match.");
      }
      return {
        ok: queried.state === "completed",
        result: queried.result ?? queried.output ?? { state: queried.state, resultSha256: queried.resultSha256 || "" },
        ...(queried.state === "failed" ? { error: queried.error ?? "Remote device operation failed." } : {}),
      };
    },
  };
}
