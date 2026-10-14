import { createServiceCredentialVault } from "./service-credential-vault.js";
import { createLocalNetworkWorkerPrivateTransport } from "./local-network-worker-transport.js";

export function assertOfficialDeviceMcpProductionStartup(env = process.env) {
  if (String(env.FABUSHI_CORE_SERVICE_STATE_REQUIRED || "") !== "1") {
    throw new Error("FABUSHI_CORE_SERVICE_STATE_REQUIRED=1 is required for the shipping official device MCP.");
  }

  // Constructing the vault validates that a non-empty base64url value decodes
  // to exactly 32 bytes. The key itself is never returned or logged.
  createServiceCredentialVault({ key: env.FABUSHI_OFFICIAL_MCP_SERVICE_VAULT_KEY });

  const networkWorkerEndpoint = String(env.FABUSHI_FDN_NETWORK_WORKER_ENDPOINT || "").trim();
  const reverseFallback = String(env.FABUSHI_FDN_AUTHENTICATED_REVERSE_WS_FALLBACK || "") === "1";
  if (!networkWorkerEndpoint && !reverseFallback) {
    throw new Error(
      "Shipping official device MCP requires FABUSHI_FDN_NETWORK_WORKER_ENDPOINT or explicit authenticated reverse-WebSocket fallback.",
    );
  }
  if (networkWorkerEndpoint) {
    // Reuse the production transport parser to fail closed on non-loopback
    // endpoints and invalid target-port configuration.
    createLocalNetworkWorkerPrivateTransport({
      endpoint: networkWorkerEndpoint,
      remotePort: env.FABUSHI_FDN_REMOTE_TARGET_PORT,
    });
  }

  return Object.freeze({
    coreServiceStateRequired: true,
    privateTransport: networkWorkerEndpoint ? "network-worker" : "authenticated-reverse-websocket",
  });
}
