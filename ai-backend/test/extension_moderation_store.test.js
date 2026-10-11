import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { AccountSyncStore } from '../src/account_sync_store.js';
import {
  ExtensionModerationStore,
  ExtensionModerationStoreError,
} from '../src/extension_moderation_store.js';
import { ExtensionPublisherStore, ExtensionPublisherStoreError } from '../src/extension_publisher_store.js';
import { ExtensionReleaseStore } from '../src/extension_release_store.js';
import { createMiniAppMarketplaceRouter } from '../src/miniapp_marketplace_http.js';

function descriptor(version = '1.0.0') {
  return {
    identity: { namespace: 'acme-labs', name: 'offline-notes', kind: 'web-miniapp' },
    origin: 'public',
    trustDomain: 'catalog-authorized',
    displayName: 'Offline Notes',
    description: 'Offline private notes.',
    publisher: { id: 'acme-labs', displayName: 'Acme Labs' },
    release: {
      version,
      channel: 'stable',
      platforms: ['desktop', 'ios', 'android'],
      requestedCapabilities: ['storage.local'],
    },
    runtime: { owner: 'web-miniapp' },
  };
}

function key(version = '1.0.0') {
  return {
    kind: 'web-miniapp',
    namespace: 'acme-labs',
    name: 'offline-notes',
    version,
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-moderation-'));
  const accountStore = new AccountSyncStore({ dbPath: path.join(root, 'marketplace.sqlite') });
  const publisherStore = new ExtensionPublisherStore({ db: accountStore.db, now: () => 1_000 });
  let nowMs = 2_000;
  const releaseStore = new ExtensionReleaseStore({
    db: accountStore.db,
    publisherStore,
    now: () => nowMs++,
  });
  const moderationStore = new ExtensionModerationStore({
    db: accountStore.db,
    publisherStore,
    releaseStore,
    now: () => nowMs++,
  });
  publisherStore.create({
    namespace: 'acme-labs',
    displayName: 'Acme Labs',
    ownerAccountId: 'user:owner',
  });
  releaseStore.createDraft({ actorAccountId: 'user:owner', descriptor: descriptor() });
  releaseStore.submit({ actorAccountId: 'user:owner', ...key() });
  releaseStore.review({ ...key(), approved: true, reviewer: 'initial-reviewer' });
  return {
    root,
    accountStore,
    publisherStore,
    releaseStore,
    moderationStore,
    close() {
      accountStore.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('authenticated report is durable, duplicate-open fenced, and audit omits report details', () => {
  const scope = fixture();
  try {
    const report = scope.moderationStore.createReport({
      reporterAccountId: 'user:reporter',
      ...key(),
      reasonCode: 'malware',
      details: 'Suspicious network behavior. Bearer user-pasted-example must not enter audit payload.',
    });
    assert.equal(report.type, 'report');
    assert.equal(report.state, 'open');
    assert.equal(report.reasonCode, 'malware');
    assert.equal(scope.moderationStore.listMine('user:reporter')[0].caseId, report.caseId);
    assert.throws(
      () => scope.moderationStore.createReport({
        reporterAccountId: 'user:reporter',
        ...key(),
        reasonCode: 'policy',
      }),
      (error) => error instanceof ExtensionModerationStoreError
        && error.code === 'DUPLICATE_OPEN_REPORT',
    );
    const audit = scope.moderationStore.audit(report.caseId);
    assert.deepEqual(audit.map((entry) => entry.action), ['report.created']);
    assert.doesNotMatch(JSON.stringify(audit), /user-pasted-example/);
  } finally {
    scope.close();
  }
});

test('dismissed report leaves approved release active', () => {
  const scope = fixture();
  try {
    const report = scope.moderationStore.createReport({
      reporterAccountId: 'user:reporter',
      ...key(),
      reasonCode: 'other',
      details: 'False positive candidate',
    });
    const resolved = scope.moderationStore.resolveReport({
      caseId: report.caseId,
      decision: 'dismiss',
      reviewer: 'security-reviewer',
      resolution: 'No violation found',
    });
    assert.equal(resolved.state, 'dismissed');
    assert.equal(scope.releaseStore.getRelease(key()).state, 'approved');
    assert.deepEqual(
      scope.moderationStore.audit(report.caseId).map((entry) => entry.action),
      ['report.created', 'report.dismissed'],
    );
  } finally {
    scope.close();
  }
});

test('substantiated report revokes release and recovery retry accepts already-revoked release', () => {
  const scope = fixture();
  try {
    const report = scope.moderationStore.createReport({
      reporterAccountId: 'user:reporter',
      ...key(),
      reasonCode: 'impersonation',
      details: 'Publisher identity abuse',
    });
    const actioned = scope.moderationStore.resolveReport({
      caseId: report.caseId,
      decision: 'revoke',
      reviewer: 'security-reviewer',
      resolution: 'Confirmed impersonation',
    });
    assert.equal(actioned.state, 'actioned');
    assert.equal(scope.releaseStore.getRelease(key()).state, 'revoked');

    scope.releaseStore.createDraft({ actorAccountId: 'user:owner', descriptor: descriptor('1.1.0') });
    scope.releaseStore.submit({ actorAccountId: 'user:owner', ...key('1.1.0') });
    scope.releaseStore.review({ ...key('1.1.0'), approved: true, reviewer: 'initial-reviewer' });
    const recoveryReport = scope.moderationStore.createReport({
      reporterAccountId: 'user:second-reporter',
      ...key('1.1.0'),
      reasonCode: 'privacy',
      details: 'Data exposure',
    });
    scope.releaseStore.revoke({
      ...key('1.1.0'),
      reviewer: 'security-reviewer',
      notes: 'revocation committed before moderation case transition',
    });
    const recovered = scope.moderationStore.resolveReport({
      caseId: recoveryReport.caseId,
      decision: 'revoke',
      reviewer: 'security-reviewer',
      resolution: 'complete interrupted moderation transition',
    });
    assert.equal(recovered.state, 'actioned');
    assert.equal(scope.releaseStore.getRelease(key('1.1.0')).state, 'revoked');
  } finally {
    scope.close();
  }
});

test('only namespace owner can appeal and accepted appeal never reactivates revoked release', () => {
  const scope = fixture();
  try {
    const report = scope.moderationStore.createReport({
      reporterAccountId: 'user:reporter',
      ...key(),
      reasonCode: 'policy',
      details: 'Policy evidence',
    });
    scope.moderationStore.resolveReport({
      caseId: report.caseId,
      decision: 'revoke',
      reviewer: 'security-reviewer',
      resolution: 'Policy breach',
    });

    assert.throws(
      () => scope.moderationStore.createAppeal({
        reportCaseId: report.caseId,
        actorAccountId: 'user:attacker',
        details: 'I should not be able to appeal this namespace',
      }),
      (error) => error instanceof ExtensionPublisherStoreError
        && error.code === 'NAMESPACE_FORBIDDEN',
    );

    const appeal = scope.moderationStore.createAppeal({
      reportCaseId: report.caseId,
      actorAccountId: 'user:owner',
      details: 'Publisher remediation evidence',
    });
    assert.equal(appeal.state, 'open');
    assert.equal(scope.moderationStore.listPublisherAppeals('user:owner')[0].caseId, appeal.caseId);
    assert.throws(
      () => scope.moderationStore.createAppeal({
        reportCaseId: report.caseId,
        actorAccountId: 'user:owner',
        details: 'duplicate appeal',
      }),
      (error) => error instanceof ExtensionModerationStoreError
        && error.code === 'DUPLICATE_OPEN_APPEAL',
    );

    const accepted = scope.moderationStore.resolveAppeal({
      caseId: appeal.caseId,
      decision: 'accept',
      reviewer: 'appeal-reviewer',
      resolution: 'Appeal accepted; publisher must ship a new reviewed version',
    });
    assert.equal(accepted.state, 'accepted');
    assert.equal(scope.releaseStore.getRelease(key()).state, 'revoked');
    assert.deepEqual(
      scope.moderationStore.audit(appeal.caseId).map((entry) => entry.action),
      ['appeal.created', 'appeal.accepted'],
    );
  } finally {
    scope.close();
  }
});

test('invalid reports fail closed before persistence', () => {
  const scope = fixture();
  try {
    assert.throws(
      () => scope.moderationStore.createReport({
        reporterAccountId: 'user:reporter',
        ...key(),
        reasonCode: 'totally-unknown',
      }),
      (error) => error instanceof ExtensionModerationStoreError
        && error.code === 'INVALID_REPORT_REASON',
    );
    assert.throws(
      () => scope.moderationStore.createReport({
        reporterAccountId: 'user:reporter',
        ...key('9.9.9'),
        reasonCode: 'other',
      }),
      (error) => error instanceof ExtensionModerationStoreError
        && error.code === 'MODERATION_RELEASE_NOT_FOUND',
    );
  } finally {
    scope.close();
  }
});

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-moderation-http-'));
  const previousReviewToken = process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN;
  process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN = 'r'.repeat(48);
  const resolveUser = async (req) => {
    const token = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (token === 'reporter-token') {
      return { userId: 'user:reporter', username: 'reporter', isAuthenticated: true };
    }
    throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  };
  const app = express();
  const { router } = createMiniAppMarketplaceRouter({
    dataDir: root,
    storagePath: path.join(root, 'marketplace.json'),
    resolveUser,
  });
  app.use(router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousReviewToken === undefined) delete process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN;
    else process.env.FABUSHI_MARKETPLACE_REVIEW_TOKEN = previousReviewToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('HTTP moderation boundaries require account identity and reviewer authority', async () => {
  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/v1/extensions/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...key(),
        reasonCode: 'other',
        details: 'anonymous reports are not accepted in v1',
      }),
    });
    assert.equal(unauthenticated.status, 401);

    const noReviewer = await fetch(
      `${baseUrl}/v1/extensions/review/reports/00000000-0000-0000-0000-000000000000/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'dismiss' }),
      },
    );
    assert.equal(noReviewer.status, 403);
    assert.equal((await noReviewer.json()).error.code, 'REVIEW_AUTH_REQUIRED');
  });
});
