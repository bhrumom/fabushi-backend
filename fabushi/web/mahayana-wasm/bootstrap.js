let worker = null;
let initialization = null;
let nextRequestId = 1;
const pending = new Map();

function call(method, args = []) {
  if (!worker) throw new Error('Mahayana WASM Worker is not initialized.');
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    worker.postMessage({ requestId, method, args });
  });
}

async function initialize() {
  if (!initialization) {
    initialization = new Promise((resolve, reject) => {
      worker = new Worker(new URL('./worker.js', import.meta.url), {
        type: 'module',
        name: 'mahayana-runtime',
      });
      worker.onmessage = (event) => {
        const response = event.data || {};
        const waiter = pending.get(response.requestId);
        if (!waiter) return;
        pending.delete(response.requestId);
        if (response.ok) waiter.resolve(response.value);
        else waiter.reject(new Error(response.message || 'Mahayana Worker failed.'));
      };
      worker.onerror = (event) => {
        reject(new Error(event.message || 'Mahayana Worker could not start.'));
      };
      call('initialize').then(resolve, reject);
    });
  }
  await initialization;
}

async function createRuntime(configJson) {
  await initialize();
  return call('createRuntime', [configJson || '{}']);
}

async function execute(runtimeId, commandJson) {
  await initialize();
  return call('execute', [runtimeId, commandJson]);
}

async function executeProduct(runtimeId, commandJson) {
  await initialize();
  return call('executeProduct', [runtimeId, commandJson]);
}

async function receive(runtimeId) {
  await initialize();
  return call('receive', [runtimeId]);
}

async function closeRuntime(runtimeId) {
  if (!worker) return;
  await call('closeRuntime', [runtimeId]);
}

window.mahayanaWasm = Object.freeze({
  initialize,
  createRuntime,
  execute,
  executeProduct,
  receive,
  closeRuntime,
});
