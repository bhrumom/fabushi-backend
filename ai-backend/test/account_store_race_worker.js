import { parentPort, workerData } from 'node:worker_threads';
import { AccountSyncStore } from '../src/account_sync_store.js';

const store = new AccountSyncStore({ dbPath: workerData.dbPath });
try {
  const barrier = new Int32Array(workerData.barrier);
  parentPort.postMessage({ ready: true });
  Atomics.wait(barrier, 0, 0, 10_000);
  const result = workerData.operation === 'delete'
    ? store.deleteAgentObject('user:race', 'agent-race', 'root', { baseEtag: workerData.baseEtag })
    : store.putAgentObject('user:race', 'agent-race', 'root', Buffer.from(workerData.content), workerData.precondition);
  parentPort.postMessage({ result });
} finally {
  store.close();
}
