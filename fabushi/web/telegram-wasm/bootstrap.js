const clients = new Map();
let nextClientId = 1;
let wasmModule = null;
let modulePromise = null;

async function initialize() {
  if (wasmModule) return;
  if (!modulePromise) {
    modulePromise = import('./fabushi_telegram.js').then(async (module) => {
      await module.default({
        module_or_path: new URL('./fabushi_telegram_bg.wasm', import.meta.url),
      });
      wasmModule = module;
    });
  }
  await modulePromise;
}

function requireModule() {
  if (!wasmModule) {
    throw new Error('Telegram WASM runtime is not initialized.');
  }
  return wasmModule;
}

function createClient() {
  const module = requireModule();
  const clientId = nextClientId++;
  clients.set(clientId, new module.TelegramWasmClient());
  return clientId;
}

function execute(clientId, requestJson) {
  const client = clients.get(clientId);
  if (!client) {
    return JSON.stringify({
      ok: false,
      errorCode: 'client_not_found',
      message: `Telegram WASM client ${clientId} does not exist.`,
    });
  }
  return client.execute(requestJson);
}

function closeClient(clientId) {
  const client = clients.get(clientId);
  if (!client) return;
  client.free();
  clients.delete(clientId);
}

window.fabushiTelegramWasm = Object.freeze({
  initialize,
  createClient,
  execute,
  closeClient,
});
