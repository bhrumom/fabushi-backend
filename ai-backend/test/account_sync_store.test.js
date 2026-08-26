import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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

test('same account converges installed Mini App and Bot while another account stays isolated', () => {
  const scope = fixture();
  try {
    const account = 'user:108';
    const install = scope.store.installMiniApp(account, globalDharmaManifest());
    assert.equal(install.added, true);
    assert.equal(scope.store.listMiniAppInstalls(account)[0].miniAppId, 'global-dharma');
    assert.equal(scope.store.listBots(account)[0].bot.id, 'global-dharma-bot');
    assert.equal(scope.store.listMiniAppInstalls('user:other').length, 0);
    assert.equal(scope.store.listBots('user:other').length, 0);

    const initial = scope.store.sync(account);
    assert.equal(initial.mode, 'snapshot');
    assert.equal(initial.snapshot.miniApps[0].miniAppId, 'global-dharma');
    assert.equal(initial.snapshot.bots[0].bot.id, 'global-dharma-bot');
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
