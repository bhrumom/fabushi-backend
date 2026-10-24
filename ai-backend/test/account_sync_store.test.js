import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { AccountSyncStore } from '../src/account_sync_store.js';

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-account-sync-'));
  let now = 1_900_000_000_000;
  const store = new AccountSyncStore({
    dbPath: path.join(root, 'sync.sqlite'),
    now: () => ++now,
    ...options,
  });
  return {
    store,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function globalDharmaManifest() {
  return {
    id: 'global-dharma',
    version: '1.0.0',
    bot: {
      id: 'global-dharma-bot',
      username: 'global_dharma_bot',
      displayName: '全球法布施',
      conversationId: 'miniapp:global-dharma',
      menuButton: { text: '打开小程序', action: 'open-miniapp', miniAppId: 'global-dharma' },
    },
  };
}

test('identical rejected Agent writes retain one durable conflict copy across reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-conflict-replay-'));
  const dbPath = path.join(root, 'sync.sqlite');
  let store = new AccountSyncStore({ dbPath, now: () => 1_900_000_000_000 });
  try {
    store.putAgentObject('user:race', 'agent-race', 'root', Buffer.from('first'), { expectAbsent: true });
    const rejected = () => store.putAgentObject('user:race', 'agent-race', 'root', Buffer.from('second'), { expectAbsent: true });
    const conflict = rejected();
    const cursor = store.currentCursor('user:race');
    for (let i = 0; i < 10; i++) {
      assert.equal(rejected().conflictPath, conflict.conflictPath);
    }
    assert.equal(store.currentCursor('user:race'), cursor, 'replay must not append duplicate sync events');
    store.close(); store = new AccountSyncStore({ dbPath });
    assert.equal(rejected().conflictPath, conflict.conflictPath);
    assert.equal(store.currentCursor('user:race'), cursor);
    assert.equal(store.listAgentObjects('user:race', 'agent-race').length, 2);
    assert.equal(store.getAgentObject('user:race', 'agent-race', 'root').data.toString(), 'first');
    assert.equal(store.getAgentObject('user:race', 'agent-race', conflict.conflictPath).data.toString(), 'second');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

async function race(dbPath, operations) {
  const barrier = new SharedArrayBuffer(4);
  const workers = operations.map((operation) => new Worker(new URL('./account_store_race_worker.js', import.meta.url), {
    workerData: { ...operation, dbPath, barrier },
  }));
  const ready = [];
  const results = [];
  for (const worker of workers) {
    let onReady, onResult;
    ready.push(new Promise((resolve, reject) => { onReady = resolve; worker.once('error', reject); }));
    results.push(new Promise((resolve, reject) => {
      onResult = resolve; worker.once('error', reject);
      worker.once('exit', (code) => { if (code !== 0) reject(new Error(`race worker exit ${code}`)); });
    }));
    worker.on('message', (message) => { if (message.ready) onReady(); else onResult(message.result); });
  }
  try {
    await Promise.all(ready);
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    return await Promise.all(results);
  } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
}

test('separate SQLite writers permit one CAS winner and preserve the losing bytes', { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-file-cas-'));
  const dbPath = path.join(root, 'sync.sqlite');
  const store = new AccountSyncStore({ dbPath });
  try {
    const initial = store.putAgentObject('user:race', 'agent-race', 'root', Buffer.from('initial'), { expectAbsent: true });
    const outcomes = await race(dbPath, ['a', 'b'].map((content) => ({ content, precondition: { baseEtag: initial.etag } })));
    assert.equal(outcomes.filter((r) => r.outcome === 'written').length, 1);
    assert.equal(outcomes.filter((r) => r.outcome === 'conflict').length, 1);
    const winner = store.getAgentObject('user:race', 'agent-race', 'root');
    const loser = store.getAgentObject('user:race', 'agent-race', outcomes.find((r) => r.outcome === 'conflict').conflictPath);
    assert.deepEqual(new Set([winner.data.toString(), loser.data.toString()]), new Set(['a', 'b']));
    const absentRace = await race(dbPath, ['c', 'd'].map((content) => ({ content, precondition: { expectAbsent: true } })));
    assert.ok(absentRace.every((r) => r.outcome === 'conflict'));
    assert.equal(store.getAgentObject('user:race', 'agent-race', 'root').etag, winner.etag);
    const deleteRace = await race(dbPath, [
      { operation: 'delete', baseEtag: winner.etag },
      { content: 'updated', precondition: { baseEtag: winner.etag } },
    ]);
    if (deleteRace[0].deleted) assert.equal(deleteRace[1].outcome, 'conflict');
    else { assert.equal(deleteRace[0].conflict, true); assert.equal(deleteRace[1].outcome, 'written'); }
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('same account converges installed Mini App and Bot while another account stays isolated', () => {
  const scope = fixture();
  try {
    const account = 'user:108';
    const install = scope.store.installMiniApp(account, globalDharmaManifest());
    assert.equal(install.added, true);
    assert.equal(scope.store.listMiniAppInstalls(account)[0].miniAppId, 'global-dharma');
    assert.equal(scope.store.listBots(account)[0].bot.id, 'global-dharma-bot');
    assert.equal(scope.store.listBots(account)[0].bot.agentId, 'global-dharma-bot');
    assert.equal(scope.store.listAgents(account)[0].agentId, 'global-dharma-bot');
    assert.equal(scope.store.listMiniAppInstalls('user:other').length, 0);
    assert.equal(scope.store.listBots('user:other').length, 0);

    const initial = scope.store.sync(account);
    assert.equal(initial.mode, 'snapshot');
    assert.equal(initial.snapshot.miniApps[0].miniAppId, 'global-dharma');
    assert.equal(initial.snapshot.bots[0].bot.id, 'global-dharma-bot');
    assert.equal(initial.snapshot.agents[0].agentId, 'global-dharma-bot');
  } finally {
    scope.close();
  }
});

test('difference cursor replays Mini App install, Bot membership, cloud state, and uninstall', () => {
  const scope = fixture();
  try {
    const account = 'user:108';
    const start = scope.store.currentCursor(account);
    scope.store.installMiniApp(account, globalDharmaManifest());
    const cloud = scope.store.setCloudValue(account, 'global-dharma', 'mode', 'local');
    assert.equal(cloud.value, 'local');

    const first = scope.store.sync(account, start, 10);
    assert.equal(first.mode, 'difference');
    assert.deepEqual(first.events.map((event) => event.type), [
      'miniapp.installed',
      'bot.added',
      'agent.created',
      'miniapp.cloud.set',
    ]);
    assert.equal(scope.store.getCloudValue(account, 'global-dharma', 'mode').value, 'local');

    const checkpoint = first.cursor;
    const removed = scope.store.removeMiniApp(account, 'global-dharma');
    assert.equal(removed.removed, true);
    const second = scope.store.sync(account, checkpoint, 10);
    assert.deepEqual(second.events.map((event) => event.type), ['miniapp.removed', 'bot.removed']);
    assert.equal(scope.store.listMiniAppInstalls(account).length, 0);
    assert.equal(scope.store.listBots(account).length, 0);
    assert.equal(scope.store.getCloudValue(account, 'global-dharma', 'mode').value, 'local', 'uninstall must not destroy Mini App cloud data');
  } finally {
    scope.close();
  }
});

test('repeating the same Mini App install does not emit spurious Agent updates', () => {
  const scope = fixture();
  try {
    const account = 'user:108';
    const start = scope.store.currentCursor(account);
    scope.store.installMiniApp(account, globalDharmaManifest());
    const first = scope.store.sync(account, start, 20);
    assert.deepEqual(first.events.map((event) => event.type), [
      'miniapp.installed',
      'bot.added',
      'agent.created',
    ]);

    const checkpoint = first.cursor;
    const repeated = scope.store.installMiniApp(account, globalDharmaManifest());
    assert.equal(repeated.changed, false);
    const afterRepeat = scope.store.sync(account, checkpoint, 20);
    assert.equal(afterRepeat.mode, 'difference');
    assert.deepEqual(afterRepeat.events, []);
  } finally {
    scope.close();
  }
});

test('manual Bot membership is independent from a Mini App installation source', () => {
  const scope = fixture();
  try {
    const account = 'user:108';
    const bot = globalDharmaManifest().bot;
    scope.store.addBot(account, bot, { source: 'manual', sourceId: 'manual' });
    scope.store.installMiniApp(account, globalDharmaManifest());
    assert.equal(scope.store.listBots(account)[0].sources.length, 2);

    scope.store.removeMiniApp(account, 'global-dharma');
    const bots = scope.store.listBots(account);
    assert.equal(bots.length, 1);
    assert.deepEqual(bots[0].sources.map((entry) => entry.source), ['manual']);
  } finally {
    scope.close();
  }
});

test('Agent Store keeps Bot identity separate, content-addresses state, and preserves conflicts', () => {
  const scope = fixture();
  try {
    const account = 'user:108';
    scope.store.addBot(account, {
      id: 'research-bot',
      agentId: 'agent-research',
      displayName: 'Research Bot',
      description: 'Researches sources',
      conversationId: 'codex:agent:agent-research',
    });

    const membership = scope.store.listBots(account)[0];
    assert.equal(membership.bot.id, 'research-bot');
    assert.equal(membership.bot.agentId, 'agent-research');

    const agent = scope.store.getAgent(account, 'agent-research');
    assert.equal(agent.profile.name, 'Research Bot');
    assert.equal(agent.metadata.agentId, 'agent-research');

    const first = scope.store.putAgentObject(
      account,
      'agent-research',
      'conversation/root.pb',
      Buffer.from('checkpoint-one'),
      { expectAbsent: true },
    );
    assert.equal(first.outcome, 'written');
    assert.match(first.etag, /^sha256:/);

    const loaded = scope.store.getAgentObject(account, 'agent-research', 'conversation/root.pb');
    assert.equal(loaded.data.toString('utf8'), 'checkpoint-one');
    assert.equal(loaded.blobId, loaded.sha256);
    assert.equal(scope.store.listAgentObjects(account, 'agent-research').length, 1);
    assert.equal(scope.store.listAgentObjects('user:other', 'agent-research').length, 0);

    const conflict = scope.store.putAgentObject(
      account,
      'agent-research',
      'conversation/root.pb',
      Buffer.from('checkpoint-two'),
      { expectAbsent: true },
    );
    assert.equal(conflict.outcome, 'conflict');
    assert.match(conflict.conflictPath, /^\.conflicts\//);
    assert.equal(
      scope.store.getAgentObject(account, 'agent-research', 'conversation/root.pb').data.toString('utf8'),
      'checkpoint-one',
      'conflicting write must not overwrite the authoritative root',
    );
    assert.equal(
      scope.store.getAgentObject(account, 'agent-research', conflict.conflictPath).data.toString('utf8'),
      'checkpoint-two',
      'conflicting data must be retained for reconciliation',
    );
  } finally {
    scope.close();
  }
});

test('CloudStorage enforces Telegram-class key/value bounds and account isolation', () => {
  const scope = fixture();
  try {
    scope.store.setCloudValue('user:a', 'global-dharma', 'language', 'zh-CN');
    assert.equal(scope.store.listCloudValues('user:a', 'global-dharma')[0].value, 'zh-CN');
    assert.equal(scope.store.listCloudValues('user:b', 'global-dharma').length, 0);
    assert.throws(() => scope.store.setCloudValue('user:a', 'global-dharma', 'bad key', 'x'), /key/i);
    assert.throws(() => scope.store.setCloudValue('user:a', 'global-dharma', 'oversize', 'x'.repeat(4097)), /4096/);

    const deleted = scope.store.deleteCloudValue('user:a', 'global-dharma', 'language');
    assert.equal(deleted.deleted, true);
    assert.equal(scope.store.listCloudValues('user:a', 'global-dharma').length, 0);
  } finally {
    scope.close();
  }
});

test('expired account cursor falls back to a safe account-scoped snapshot', () => {
  const scope = fixture({ eventRetention: 16 });
  try {
    const account = 'user:108';
    scope.store.installMiniApp(account, globalDharmaManifest());
    for (let index = 0; index < 24; index += 1) {
      scope.store.setCloudValue(account, 'global-dharma', `k${index}`, `v${index}`);
    }
    const recovered = scope.store.sync(account, 'as1:0', 5);
    assert.equal(recovered.mode, 'snapshot');
    assert.equal(recovered.reason, 'cursor-expired');
    assert.equal(recovered.snapshot.miniApps[0].miniAppId, 'global-dharma');
    assert.equal(recovered.snapshot.bots[0].bot.id, 'global-dharma-bot');
    assert.equal(recovered.snapshot.cloudRevisions.length, 24);
  } finally {
    scope.close();
  }
});
