import assert from 'node:assert/strict';
import test from 'node:test';
import { runFromEnvironment } from './human-messaging-production-readiness.mjs';

const SOURCE = 'a'.repeat(40);
const CHECK_SOURCE = 'b'.repeat(40);
const VERSION = '3ad1a889-4c28-4344-8472-8c8adc225a3c';
const DEPLOYMENT = '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e';
const SIGNED_LOG = 'https://productionresultssa8.blob.core.windows.net/actions-results/job.log?sig=fixture-only';
const RUN = 40047409890;
const JOB = 120732189309;
const FIXTURE = { actorUserId: 101, peerUserId: 202, noncontactUserId: 303,
  emptyPeerUserId: 404, pageSize: 2, expectedMessageIds: [10, 20, 30, 40, 50] };

function environment() {
  return {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bhrumom/fabushi-backend',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: CHECK_SOURCE, GITHUB_TOKEN: 'github-read-fixture-token',
    FABUSHI_MESSAGE_PROBE_DISPATCH: 'true', FABUSHI_MESSAGE_PROBE_AUTHORIZED: 'true',
    FABUSHI_MESSAGE_PROBE_EXPECTED_SOURCE_SHA: SOURCE,
    FABUSHI_MESSAGE_PROBE_APPROVED_SOURCE_SHA: SOURCE,
    FABUSHI_MESSAGE_PROBE_PROVENANCE_RUN_ID: String(RUN),
    FABUSHI_MESSAGE_PROBE_CF_READ_TOKEN: 'cloudflare-read-fixture-token',
    FABUSHI_MESSAGE_PROBE_CF_ACCOUNT_ID: 'c'.repeat(32),
    FABUSHI_MESSAGE_PROBE_ACCOUNT_TOKEN: 'actor-fixture-token',
    FABUSHI_MESSAGE_PROBE_NONCONTACT_TOKEN: 'noncontact-fixture-token',
    FABUSHI_MESSAGE_PROBE_FIXTURE_JSON: JSON.stringify(FIXTURE),
  };
}
function harness(overrides = {}, env = environment()) {
  const calls = [];
  const state = { peerReads: 0, deploymentReads: 0, domainReads: 0 };
  async function fetchImpl(input, options) {
    const url = new URL(input);
    const call = { url: url.href, options };
    calls.push(call);
    async function reply(kind, body, status = 200, headers = { 'content-type': 'application/json' }, context = {}) {
      const initial = { kind, body, status, headers, context, state, call };
      const replacement = overrides[kind] ? await overrides[kind](initial) : null;
      if (replacement instanceof Response) return replacement;
      const result = { ...initial, ...(replacement ?? {}) };
      const content = result.body === null ? null
        : typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
      return new Response(content, { status: result.status, headers: result.headers });
    }
    if (url.origin === 'https://api.github.com') {
      if (url.pathname.endsWith('/actions/runs/' + RUN)) {
        return reply('run', { id: RUN, repository: { full_name: 'bhrumom/fabushi-backend' },
          head_repository: { full_name: 'bhrumom/fabushi-backend' },
          path: '.github/workflows/production-worker-delivery.yml', event: 'workflow_dispatch',
          head_branch: 'main', status: 'completed', conclusion: 'success', head_sha: SOURCE, run_attempt: 1 });
      }
      if (url.pathname.endsWith('/attempts/1/jobs')) {
        const names = ['Require canonical main dispatch', 'Checkout exact canonical source',
          'Verify exact source SHA', 'Apply production D1 migrations', 'Deploy production Worker',
          'Verify public production health', 'Write production provenance', 'Upload production delivery provenance'];
        return reply('jobs', { total_count: 1, jobs: [{ id: JOB, run_id: RUN, head_sha: SOURCE,
          name: 'Migrate and deploy canonical production Worker', status: 'completed', conclusion: 'success',
          steps: names.map((name) => ({ name, status: 'completed', conclusion: 'success' })) }] });
      }
      if (url.pathname.endsWith('/actions/jobs/' + JOB + '/logs')) {
        return reply('logRedirect', null, 302, { location: SIGNED_LOG });
      }
    }
    if (url.href === SIGNED_LOG || url.hostname === 'results-receiver.actions.githubusercontent.com') {
      const log = ['[command]/usr/bin/git log -1 --format=%H', SOURCE,
        'Uploaded fabushi-flutter-web-prod (2.48 sec)',
        'Deployed fabushi-flutter-web-prod triggers (0.97 sec)', 'Current Version ID: ' + VERSION]
        .map((line) => '2026-10-24T00:56:43.3371948Z ' + line).join('\n') + '\n';
      return reply('log', log, 200, { 'content-type': 'text/plain' });
    }
    if (url.origin === 'https://api.cloudflare.com') {
      if (url.pathname.endsWith('/workers/domains')) {
        state.domainReads += 1;
        return reply('domains', { success: true, errors: [], result: [
          { hostname: 'api.ombhrum.com', service: 'fabushi-flutter-web-prod', enabled: true, environment: 'production' },
        ] });
      }
      if (url.pathname.endsWith('/workers/scripts/fabushi-flutter-web-prod/deployments')) {
        state.deploymentReads += 1;
        return reply('deployments', { success: true, errors: [], result: { deployments: [
          { id: DEPLOYMENT, strategy: 'percentage', versions: [{ version_id: VERSION, percentage: 100 }] },
        ] } });
      }
    }
    if (url.origin === 'https://api.ombhrum.com') {
      const authorization = options.headers.authorization;
      if (url.pathname === '/api/auth/user-info') {
        const actor = authorization === 'Bearer ' + env.FABUSHI_MESSAGE_PROBE_ACCOUNT_TOKEN;
        return reply('identity', { id: actor ? FIXTURE.actorUserId : FIXTURE.noncontactUserId,
          role: 'user', isAdmin: false }, 200, { 'content-type': 'application/json' }, { actor });
      }
      if (url.pathname === '/api/social/messages') {
        if (!authorization) return reply('anonymous', { success: false, error: 'authentication required' }, 401);
        if (authorization === 'Bearer ' + env.FABUSHI_MESSAGE_PROBE_NONCONTACT_TOKEN) {
          return reply('noncontact', { success: false, error: 'friendship required' }, 403);
        }
        const peerId = Number(url.searchParams.get('contactId'));
        const afterId = Number(url.searchParams.get('afterId'));
        const limit = Number(url.searchParams.get('limit'));
        if (peerId === FIXTURE.peerUserId) state.peerReads += 1;
        const ids = peerId === FIXTURE.emptyPeerUserId ? []
          : FIXTURE.expectedMessageIds.filter((id) => id > afterId).slice(0, limit);
        const messages = ids.map((id) => ({ id, senderUserId: FIXTURE.actorUserId, recipientUserId: peerId,
          isOutgoing: true, text: 'private-fixture-message-body', clientRequestId: 'private-fixture-client-id' }));
        return reply('page', { success: true, data: { contact: { id: peerId, userId: peerId },
          messages, historyCursor: { mode: 'after-id', afterId },
          nextAfterId: ids.length ? ids[ids.length - 1] : afterId } },
        200, { 'content-type': 'application/json' }, { peerId, afterId, limit });
      }
    }
    throw new Error('Unexpected fixture request');
  }
  return { fetchImpl, calls, state };
}
async function execute(overrides = {}, env = environment(), extra = {}) {
  const mock = harness(overrides, env);
  const report = await runFromEnvironment(env, { fetchImpl: mock.fetchImpl, ...extra });
  return { report, ...mock };
}

// 01
test('requires explicit canonical Actions dispatch and protected production authorization before network access', async () => {
  for (const [key, value] of [
    ['GITHUB_ACTIONS', 'false'], ['GITHUB_REPOSITORY', 'foreign/repo'],
    ['GITHUB_REF', 'refs/heads/checkpoint'], ['GITHUB_EVENT_NAME', 'push'],
    ['FABUSHI_MESSAGE_PROBE_DISPATCH', 'false'], ['FABUSHI_MESSAGE_PROBE_AUTHORIZED', 'false'],
    ['FABUSHI_MESSAGE_PROBE_APPROVED_SOURCE_SHA', CHECK_SOURCE],
  ]) {
    const { report, calls } = await execute({}, { ...environment(), [key]: value });
    assert.equal(report.status, 'blocked');
    assert.equal(calls.length, 0);
  }
});
// 02
test('missing credentials, source and fixture fail closed with no account or token fallback', async () => {
  for (const name of ['GITHUB_TOKEN', 'GITHUB_SHA', 'FABUSHI_MESSAGE_PROBE_CF_READ_TOKEN',
    'FABUSHI_MESSAGE_PROBE_CF_ACCOUNT_ID', 'FABUSHI_MESSAGE_PROBE_ACCOUNT_TOKEN',
    'FABUSHI_MESSAGE_PROBE_NONCONTACT_TOKEN', 'FABUSHI_MESSAGE_PROBE_FIXTURE_JSON',
    'FABUSHI_MESSAGE_PROBE_EXPECTED_SOURCE_SHA', 'FABUSHI_MESSAGE_PROBE_PROVENANCE_RUN_ID']) {
    const env = environment();
    delete env[name];
    const { report, calls } = await execute({}, env);
    assert.equal(report.status, 'blocked');
    assert.equal(calls.length, 0);
  }
});
// 03
test('rejects malformed or insufficient existing fixtures before any request', async () => {
  for (const change of [
    { actorUserId: FIXTURE.peerUserId }, { peerUserId: 'https://foreign.invalid' },
    { pageSize: 0 }, { pageSize: 201 }, { expectedMessageIds: [10, 20] },
    { expectedMessageIds: [10, 20, 20] }, { expectedMessageIds: [10, 20, Number.MAX_SAFE_INTEGER + 1] },
    { pageSize: 1, expectedMessageIds: Array.from({ length: 32 }, (_, index) => index + 1) },
  ]) {
    const env = environment();
    env.FABUSHI_MESSAGE_PROBE_FIXTURE_JSON = JSON.stringify({ ...FIXTURE, ...change });
    const { report, calls } = await execute({}, env);
    assert.equal(report.status, 'blocked');
    assert.equal(calls.length, 0);
  }
});
// 04
test('reads the full source chain and proves multipage, origin-empty, denial and checkpoint-reread behavior', async () => {
  const { report } = await execute();
  assert.equal(report.status, 'passed');
  assert.equal(report.source.sourceSha, SOURCE);
  assert.equal(report.source.workerVersionId, VERSION);
  assert.equal(report.source.deploymentId, DEPLOYMENT);
  assert.equal(report.source.controlPlaneChecks, 'before-and-after');
  assert.match(report.source.completeLogSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.counts, { expectedMessages: 5, observedMessages: 5, nonemptyPages: 3,
    checkpointOrdinal: 2, rereadMessages: 3 });
  assert.equal(report.pages.filter((page) => page.empty).length, 3);
  assert.equal(report.recoveryScope, 'client-readonly-checkpoint-reread');
  assert.equal(report.remoteD1Recovery, 'not-verified');
  assert.equal(report.durableClientRestart, 'not-verified');
  assert.equal(report.independentAccept, 'not-verified');
});
// 05
test('every operation is GET and each token stays at its own fixed origin while log download is anonymous', async () => {
  const env = environment();
  const { report, calls } = await execute({}, env);
  assert.equal(report.status, 'passed');
  for (const { url, options } of calls) {
    const parsed = new URL(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    if (parsed.origin === 'https://api.github.com') {
      assert.equal(options.headers.authorization, 'Bearer ' + env.GITHUB_TOKEN);
      assert.equal(options.redirect, parsed.pathname.endsWith('/logs') ? 'manual' : 'error');
      assert.ok(parsed.pathname.startsWith('/repos/bhrumom/fabushi-backend/'));
    } else if (parsed.origin === 'https://api.cloudflare.com') {
      assert.equal(options.headers.authorization, 'Bearer ' + env.FABUSHI_MESSAGE_PROBE_CF_READ_TOKEN);
      assert.equal(options.redirect, 'error');
    } else if (parsed.origin === 'https://api.ombhrum.com') {
      assert.ok([undefined, 'Bearer ' + env.FABUSHI_MESSAGE_PROBE_ACCOUNT_TOKEN,
        'Bearer ' + env.FABUSHI_MESSAGE_PROBE_NONCONTACT_TOKEN].includes(options.headers.authorization));
      assert.equal(options.redirect, 'error');
    } else {
      assert.equal(url, SIGNED_LOG);
      assert.deepEqual(options.headers, { accept: 'text/plain' });
      assert.equal(options.redirect, 'error');
    }
  }
});
// 06
test('a source SHA input cannot substitute for a successful canonical production dispatch', async () => {
  for (const change of [{ head_sha: CHECK_SOURCE }, { path: '.github/workflows/human-messaging-ci.yml' },
    { head_branch: 'checkpoint' }, { conclusion: 'failure' }, { status: 'in_progress' },
    { event: 'pull_request' }, { head_repository: { full_name: 'foreign/repo' } }]) {
    const { report, calls } = await execute({ run: ({ body }) => ({ body: { ...body, ...change } }) });
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.reasonCodes, ['canonical_delivery_not_verified']);
    assert.equal(calls.some((call) => call.url.startsWith('https://api.ombhrum.com')), false);
  }
});
// 07
test('requires the complete exact-attempt successful deployment job and its critical steps', async () => {
  for (const mutate of [
    (body) => { body.total_count = 101; },
    (body) => { body.jobs[0].head_sha = CHECK_SOURCE; },
    (body) => { body.jobs[0].run_id += 1; },
    (body) => { body.jobs[0].steps[4].conclusion = 'skipped'; },
    (body) => { body.jobs.push(structuredClone(body.jobs[0])); body.total_count = 2; },
  ]) {
    const { report, calls } = await execute({ jobs: ({ body }) => { mutate(body); return { body }; } });
    assert.equal(report.status, 'blocked');
    assert.equal(calls.some((call) => call.url.startsWith('https://api.ombhrum.com')), false);
  }
});
// 08
test('rejects untrusted, insecure and credential-bearing job log Locations without following them', async () => {
  for (const location of ['https://example.com/log?sig=x', 'http://productionresultssa8.blob.core.windows.net/log?sig=x',
    'https://user:password@productionresultssa8.blob.core.windows.net/log?sig=x',
    'https://productionresultssa8.blob.core.windows.net.evil.invalid/log?sig=x',
    'https://productionresultssa8.blob.core.windows.net:444/log?sig=x',
    'https://productionresultssa8.blob.core.windows.net/log',
    'https://127.0.0.1/log?sig=x']) {
    const { report, calls } = await execute({ logRedirect: () => ({ headers: { location } }) });
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.reasonCodes, ['github_log_location_invalid']);
    assert.equal(calls.length, 3);
  }
});
// 09
test('accepts the documented alternate Actions log host without forwarding any credential', async () => {
  const location = 'https://results-receiver.actions.githubusercontent.com/log?sig=fixture-only';
  const { report, calls } = await execute({ logRedirect: () => ({ headers: { location } }) });
  assert.equal(report.status, 'passed');
  assert.deepEqual(calls.find((call) => call.url === location).options.headers, { accept: 'text/plain' });
});
// 10
test('rejects a second log redirect and incomplete or ambiguous deployed version logs', async () => {
  const variations = [
    { log: () => ({ status: 302, body: null, headers: { location: 'https://example.com/' } }) },
    { log: ({ body }) => ({ body: body.replace(SOURCE, CHECK_SOURCE) }) },
    { log: ({ body }) => ({ body: body.replace('Uploaded fabushi-flutter-web-prod', 'Uploaded unrelated-worker') }) },
    { log: ({ body }) => ({ body: body + '2026-10-24T00:56:43Z Current Version ID: ' + VERSION + '\n' }) },
  ];
  for (const overrides of variations) {
    const { report, calls } = await execute(overrides);
    assert.equal(report.status, 'blocked');
    assert.equal(calls.some((call) => call.url.startsWith('https://api.ombhrum.com')), false);
  }
});
// 11
test('requires the live custom domain to target the enabled production canonical messaging Worker', async () => {
  for (const change of [{ enabled: false }, { hostname: 'foreign.invalid' }, { service: 'mahayana-platform' },
    { environment: 'staging' }, { environment: undefined }]) {
    const { report, calls } = await execute({ domains: ({ body }) => {
      Object.assign(body.result[0], change); return { body };
    } });
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.reasonCodes, ['live_worker_domain_mismatch']);
    assert.equal(calls.some((call) => call.url.startsWith('https://api.ombhrum.com')), false);
  }
});
// 12
test('rejects mismatched, split or absent active Worker versions rather than using historical deployment alone', async () => {
  for (const versions of [
    [{ version_id: DEPLOYMENT, percentage: 100 }],
    [{ version_id: VERSION, percentage: 50 }, { version_id: DEPLOYMENT, percentage: 50 }],
    [],
  ]) {
    const { report, calls } = await execute({ deployments: ({ body }) => {
      body.result.deployments[0].versions = versions; return { body };
    } });
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.reasonCodes, ['live_worker_version_mismatch']);
    assert.equal(calls.some((call) => call.url.startsWith('https://api.ombhrum.com')), false);
  }
});
// 13
test('a deployment or domain change during message traversal invalidates the provenance result', async () => {
  const changed = '282bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e';
  for (const overrides of [
    { deployments: ({ body, state }) => {
      if (state.deploymentReads === 2) body.result.deployments[0].id = changed;
      return { body };
    } },
    { domains: ({ body, state }) => {
      if (state.domainReads === 2) body.result[0].enabled = false;
      return { body };
    } },
  ]) {
    const { report } = await execute(overrides);
    assert.equal(report.status, 'blocked');
    assert.equal(report.productionAcceptance, 'not-established');
    assert.equal(report.source.controlPlaneChecks, 'before-only');
  }
});
// 14
test('rejects the wrong ordinary account or a privileged identity even with a successful HTTP response', async () => {
  for (const change of [{ id: 999 }, { role: 'admin' }, { isAdmin: true }]) {
    const { report } = await execute({ identity: ({ body }) => ({ body: { ...body, ...change } }) });
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.reasonCodes, ['actor_identity_mismatch']);
  }
});
// 15
test('anonymous and authenticated noncontact denial require their exact status and no message payload', async () => {
  for (const overrides of [
    { anonymous: () => ({ status: 200 }) },
    { anonymous: () => ({ status: 403 }) },
    { noncontact: () => ({ status: 401 }) },
    { noncontact: () => ({ status: 404 }) },
    { noncontact: ({ body }) => ({ body: { ...body, data: { messages: [] } } }) },
  ]) {
    const { report } = await execute(overrides);
    assert.equal(report.status, 'failed');
    assert.equal(report.productionAcceptance, 'not-established');
  }
});
// 16
test('explicit origin and terminal requests require the exact cursor echo and contact identity', async () => {
  for (const mutate of [
    (data) => { delete data.historyCursor; },
    (data) => { data.historyCursor.mode = 'before'; },
    (data) => { data.historyCursor.afterId += 1; },
    (data) => { data.contact.id = 999; },
  ]) {
    const { report } = await execute({ page: ({ body }) => { mutate(body.data); return { body }; } });
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.reasonCodes, ['history_page_contract_invalid']);
  }
});
// 17
test('message IDs must be safe, strictly ascending and unique within and across pages', async () => {
  for (const secondId of [10, 5, Number.MAX_SAFE_INTEGER + 1]) {
    const { report } = await execute({ page: ({ body, state }) => {
      if (state.peerReads === 1) body.data.messages[1].id = secondId;
      return { body };
    } });
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.reasonCodes, ['history_id_order_invalid']);
  }
  const { report } = await execute({ page: ({ body, state }) => {
    if (state.peerReads === 2) body.data.messages[0].id = 20;
    return { body };
  } });
  assert.deepEqual(report.reasonCodes, ['history_id_order_invalid']);
});
// 18
test('pair isolation and outgoing actor projection reject foreign messages before evidence is accepted', async () => {
  for (const mutate of [
    (message) => { message.senderUserId = 999; },
    (message) => { message.recipientUserId = FIXTURE.noncontactUserId; },
    (message) => { message.isOutgoing = false; },
  ]) {
    const { report } = await execute({ page: ({ body, state }) => {
      if (state.peerReads === 1) mutate(body.data.messages[0]); return { body };
    } });
    assert.equal(report.status, 'failed');
  }
});
// 19
test('an approved exact fixture detects missing, extra and changed identities without relying on server totals', async () => {
  for (const overrides of [
    { page: ({ body, state }) => {
      if (state.peerReads === 1) body.data.messages[1].id = 30; return { body };
    } },
    { page: ({ body, state }) => {
      if (state.peerReads === 1) body.data.messages.push({ ...body.data.messages[1], id: 30 }); return { body };
    } },
    { page: ({ body, context, state }) => {
      if (state.peerReads === 2) { body.data.messages = []; body.data.nextAfterId = context.afterId; }
      return { body };
    } },
  ]) {
    const { report } = await execute(overrides);
    assert.equal(report.status, 'failed');
  }
});
// 20
test('empty origin and terminal pages preserve their exact cursor and never imply skipped history', async () => {
  for (const mode of ['origin', 'terminal']) {
    const { report } = await execute({ page: ({ body, context }) => {
      if ((mode === 'origin' && context.peerId === FIXTURE.emptyPeerUserId)
        || (mode === 'terminal' && context.afterId === 50)) body.data.nextAfterId = null;
      return { body };
    } });
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.reasonCodes, ['history_next_cursor_invalid']);
  }
});
// 21
test('checkpoint reread compares the exact previously approved suffix and remains client-readonly scope', async () => {
  const { report } = await execute({ page: ({ body, state }) => {
    if (state.peerReads === 5) body.data.messages[0].id = 35;
    return { body };
  } });
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.reasonCodes, ['history_fixture_mismatch']);
  assert.equal(report.recoveryScope, 'client-readonly-checkpoint-reread');
  assert.equal(report.remoteD1Recovery, 'not-verified');
});
// 22
test('bounded streams reject oversized declared logs and oversized untrusted message bodies', async () => {
  const log = await execute({ log: () => ({ headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }) });
  assert.equal(log.report.status, 'blocked');
  assert.deepEqual(log.report.reasonCodes, ['delivery_log_body_limit']);
  const page = await execute({ page: () => new Response(' '.repeat(2 * 1024 * 1024 + 1),
    { headers: { 'content-type': 'application/json' } }) });
  assert.equal(page.report.status, 'failed');
  assert.deepEqual(page.report.reasonCodes, ['origin_traversal_body_limit']);
});
// 23
test('timeouts, malformed JSON and provider failures stay nonzero and never emit raw diagnostic values', async () => {
  const poison = 'secret-token private-user-id private-message-body';
  for (const overrides of [
    { run: () => { throw new Error(poison); } },
    { deployments: () => ({ status: 403, body: { error: poison } }) },
    { page: () => ({ body: poison }) },
  ]) {
    const { report } = await execute(overrides);
    assert.notEqual(report.status, 'passed');
    assert.equal(JSON.stringify(report).includes(poison), false);
  }
  let ticks = 0;
  const { report, calls } = await execute({}, environment(), { now: () => ticks++ * 240_001 });
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.reasonCodes, ['time_budget_exhausted']);
  assert.equal(calls.length, 0);
});
// 24
test('successful evidence stores only public source references and redacted cursor ordinals', async () => {
  const env = environment();
  const { report } = await execute({}, env);
  assert.equal(report.status, 'passed');
  const evidence = JSON.stringify(report);
  for (const value of [env.GITHUB_TOKEN, env.FABUSHI_MESSAGE_PROBE_CF_READ_TOKEN,
    env.FABUSHI_MESSAGE_PROBE_CF_ACCOUNT_ID, env.FABUSHI_MESSAGE_PROBE_ACCOUNT_TOKEN,
    env.FABUSHI_MESSAGE_PROBE_NONCONTACT_TOKEN, SIGNED_LOG,
    'private-fixture-message-body', 'private-fixture-client-id', 'senderUserId', 'recipientUserId',
    'expectedMessageIds', 'contactId', 'afterId', 'nextAfterId']) {
    assert.equal(evidence.includes(value), false);
  }
  assert.deepEqual(Object.keys(report.pages[0]).sort(), ['afterOrdinal', 'check', 'count', 'empty', 'nextOrdinal']);
});
