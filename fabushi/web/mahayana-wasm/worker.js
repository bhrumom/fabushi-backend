import init, { MahayanaWebRuntime } from './mahayana_runtime.js';

const runtimes = new Map();
let nextRuntimeId = 1;
let initialized = false;
let opfsDirectory = null;

async function initialize() {
  if (initialized) return;
  await init({
    module_or_path: new URL('./mahayana_runtime_bg.wasm', import.meta.url),
  });
  if (navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory();
    opfsDirectory = await root.getDirectoryHandle('mahayana-runtime', {
      create: true,
    });
    const metadata = await opfsDirectory.getFileHandle('runtime.json', {
      create: true,
    });
    const writer = await metadata.createWritable();
    await writer.write(JSON.stringify({
      runtimeAbiVersion: 1,
      conversationSchemaVersion: 1,
      storage: 'opfs',
    }));
    await writer.close();
  }
  initialized = true;
}

function requireRuntime(runtimeId) {
  const runtime = runtimes.get(runtimeId);
  if (!runtime) throw new Error(`Mahayana WASM runtime ${runtimeId} does not exist.`);
  return runtime;
}

self.onmessage = async (event) => {
  const { requestId, method, args = [] } = event.data || {};
  try {
    let value = null;
    switch (method) {
      case 'initialize':
        await initialize();
        value = { storage: opfsDirectory ? 'opfs' : 'memory' };
        break;
      case 'createRuntime': {
        await initialize();
        const runtimeId = nextRuntimeId++;
        runtimes.set(runtimeId, new MahayanaWebRuntime(args[0] || '{}'));
        value = runtimeId;
        break;
      }
      case 'execute':
        value = requireRuntime(args[0]).execute(args[1]);
        break;
      case 'receive':
        value = requireRuntime(args[0]).receive() ?? null;
        break;
      case 'closeRuntime': {
        const runtime = runtimes.get(args[0]);
        if (runtime) runtime.free();
        runtimes.delete(args[0]);
        break;
      }
      default:
        throw new Error(`Unsupported Mahayana Worker method: ${method}`);
    }
    self.postMessage({ requestId, ok: true, value });
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

