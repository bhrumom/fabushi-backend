import init, { MahayanaWebRuntime } from './mahayana_runtime.js';
import initOfficialMiniApps, {
  OfficialMiniAppRuntime,
} from './official-miniapps/fabushi_official_miniapps.js';

const OFFICIAL_PLUGIN_IDS = [
  'global-dharma',
  'faliu-flashcards',
  'platform-publish',
  'hermes-installer',
  'bot-father',
  'mahayana-assistant',
];

const runtimes = new Map();
let nextRuntimeId = 1;
let initialized = false;
let opfsDirectory = null;
let officialMiniAppsDirectory = null;

async function initialize() {
  if (initialized) return;
  await init({
    module_or_path: new URL('./mahayana_runtime_bg.wasm', import.meta.url),
  });
  await initOfficialMiniApps({
    module_or_path: new URL(
      './official-miniapps/fabushi_official_miniapps_bg.wasm',
      import.meta.url,
    ),
  });
  if (navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory();
    opfsDirectory = await root.getDirectoryHandle('mahayana-runtime', {
      create: true,
    });
    officialMiniAppsDirectory = await opfsDirectory.getDirectoryHandle(
      'official-miniapps',
      { create: true },
    );
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

async function readOfficialMiniAppState(pluginId) {
  if (!officialMiniAppsDirectory) return '';
  try {
    const handle = await officialMiniAppsDirectory.getFileHandle(
      `${pluginId}.json`,
    );
    return await (await handle.getFile()).text();
  } catch {
    return '';
  }
}

async function writeOfficialMiniAppState(pluginId, stateJson) {
  if (!officialMiniAppsDirectory) return;
  const handle = await officialMiniAppsDirectory.getFileHandle(
    `${pluginId}.json`,
    { create: true },
  );
  const writer = await handle.createWritable();
  await writer.write(stateJson);
  await writer.close();
}

async function registerOfficialMiniApps(hostRuntime) {
  const registry = self.__mahayanaLocalPlugins || Object.create(null);
  self.__mahayanaLocalPlugins = registry;
  for (const pluginId of OFFICIAL_PLUGIN_IDS) {
    const pluginRuntime = new OfficialMiniAppRuntime(
      pluginId,
      await readOfficialMiniAppState(pluginId),
    );
    const manifest = JSON.parse(pluginRuntime.manifestJson());
    const tools = JSON.parse(pluginRuntime.toolsJson());
    const commandTools = manifest.mahayana?.commands || {};
    registry[pluginId] = Object.freeze({
      callTool(tool, args = {}) {
        const outcome = JSON.parse(
          pluginRuntime.callToolOutcome(tool, JSON.stringify(args)),
        );
        void writeOfficialMiniAppState(pluginId, pluginRuntime.exportState());
        return outcome.result;
      },
      callToolOutcome(tool, args = {}) {
        const outcome = JSON.parse(
          pluginRuntime.callToolOutcome(tool, JSON.stringify(args)),
        );
        void writeOfficialMiniAppState(pluginId, pluginRuntime.exportState());
        return outcome;
      },
      homeHtml() {
        return pluginRuntime.homeHtml();
      },
    });
    hostRuntime.register_local_plugin(JSON.stringify({
      pluginId,
      title: manifest.plugin?.title || manifest.plugin?.name || pluginId,
      tools,
      commandTools,
      approvedTools: [],
      uiHtml: pluginRuntime.homeHtml(),
    }));
  }
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
        const runtime = new MahayanaWebRuntime(args[0] || '{}');
        await registerOfficialMiniApps(runtime);
        runtimes.set(runtimeId, runtime);
        value = runtimeId;
        break;
      }
      case 'execute':
        value = requireRuntime(args[0]).execute(args[1]);
        break;
      case 'executeProduct':
        value = await requireRuntime(args[0]).execute_product(args[1]);
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
