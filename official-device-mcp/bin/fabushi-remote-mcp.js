#!/usr/bin/env node
import { createFabushiRemoteMcpServer } from "../lib/fabushi-remote-mcp-server.js";

const service = createFabushiRemoteMcpServer();
const address = await service.listen();
const host = typeof address === "object" && address ? address.address : service.host;
const port = typeof address === "object" && address ? address.port : service.requestedPort;
console.log(`Fabushi device-control MCP listening on http://${host}:${port}${service.mcpPath}; device agents use ${service.agentPath}.`);

let closing = false;
async function close(signal) {
  if (closing) return;
  closing = true;
  console.log(`Fabushi device-control MCP stopping after ${signal}.`);
  await service.close();
  process.exit(0);
}
process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));
