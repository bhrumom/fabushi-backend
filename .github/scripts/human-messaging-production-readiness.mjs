import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'bhrumom/fabushi-backend';
const WORKER = 'fabushi-flutter-web-prod';
const MESSAGE_ORIGIN = 'https://api.ombhrum.com';
const GITHUB_ORIGIN = 'https://api.github.com';
const CLOUDFLARE_ORIGIN = 'https://api.cloudflare.com';
const WORKFLOW = '.github/workflows/production-worker-delivery.yml';
const DEPLOY_JOB = 'Migrate and deploy canonical production Worker';
const MAX_PAGES = 32;
const MAX_REQUESTS = 80;
const REQUEST_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 240_000;
const JSON_BYTES = 2 * 1024 * 1024;
const LOG_BYTES = 8 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

class ProbeFailure extends Error {
  constructor(kind, code) {
    super(code);
    this.kind = kind;
    this.code = code;
  }
}
function requireCondition(value, kind, code) {
  if (!value) throw new ProbeFailure(kind, code);
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positiveId(value, code) {
  requireCondition((typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0, 'blocked', code);
  return Number(value);
}
function token(value, code) {
  requireCondition(typeof value === 'string' && value.length > 0 && value.length <= 16_384
    && /^[A-Za-z0-9._~+/-]+=*$/.test(value), 'blocked', code);
  return value;
}
function parseFixture(value) {
  requireCondition(typeof value === 'string' && Buffer.byteLength(value) <= 128 * 1024,
    'blocked', 'fixture_missing_or_oversized');
  let fixture;
  try { fixture = JSON.parse(value); } catch { throw new ProbeFailure('blocked', 'fixture_invalid'); }
  requireCondition(object(fixture), 'blocked', 'fixture_invalid');
  const identities = ['actorUserId', 'peerUserId', 'noncontactUserId', 'emptyPeerUserId'];
  for (const name of identities) fixture[name] = positiveId(fixture[name], 'fixture_identity_invalid');
  requireCondition(new Set(identities.map((name) => fixture[name])).size === 4,
    'blocked', 'fixture_identities_not_distinct');
  requireCondition(Number.isInteger(fixture.pageSize) && fixture.pageSize >= 1 && fixture.pageSize <= 200,
    'blocked', 'fixture_page_size_invalid');
  requireCondition(Array.isArray(fixture.expectedMessageIds)
    && fixture.expectedMessageIds.length > fixture.pageSize
    && fixture.expectedMessageIds.length <= fixture.pageSize * (MAX_PAGES - 1),
  'blocked', 'fixture_multipage_budget_invalid');
  let previous = 0;
  for (const id of fixture.expectedMessageIds) {
    requireCondition(Number.isSafeInteger(id) && id > previous, 'blocked', 'fixture_message_order_invalid');
    previous = id;
  }
  return fixture;
}
function readConfig(env) {
  requireCondition(env.GITHUB_ACTIONS === 'true'
    && env.GITHUB_REPOSITORY === REPOSITORY
    && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.FABUSHI_MESSAGE_PROBE_DISPATCH === 'true',
  'blocked', 'explicit_canonical_actions_dispatch_required');
  requireCondition(env.FABUSHI_MESSAGE_PROBE_AUTHORIZED === 'true',
    'blocked', 'protected_production_authorization_required');
  requireCondition(SHA.test(env.GITHUB_SHA ?? ''), 'blocked', 'check_source_sha_missing');
  const expectedSha = env.FABUSHI_MESSAGE_PROBE_EXPECTED_SOURCE_SHA;
  requireCondition(SHA.test(expectedSha ?? '')
    && expectedSha === env.FABUSHI_MESSAGE_PROBE_APPROVED_SOURCE_SHA,
  'blocked', 'approved_production_source_required');
  const config = {
    checkSourceSha: env.GITHUB_SHA,
    expectedSha,
    runId: positiveId(env.FABUSHI_MESSAGE_PROBE_PROVENANCE_RUN_ID, 'provenance_run_required'),
    githubToken: token(env.GITHUB_TOKEN, 'github_read_token_missing'),
    cfToken: token(env.FABUSHI_MESSAGE_PROBE_CF_READ_TOKEN, 'cloudflare_read_token_missing'),
    cfAccountId: env.FABUSHI_MESSAGE_PROBE_CF_ACCOUNT_ID,
    accountToken: token(env.FABUSHI_MESSAGE_PROBE_ACCOUNT_TOKEN, 'account_token_missing'),
    noncontactToken: token(env.FABUSHI_MESSAGE_PROBE_NONCONTACT_TOKEN, 'noncontact_token_missing'),
    fixture: parseFixture(env.FABUSHI_MESSAGE_PROBE_FIXTURE_JSON),
  };
  requireCondition(/^[a-f0-9]{32}$/.test(config.cfAccountId ?? ''),
    'blocked', 'cloudflare_account_configuration_missing');
  requireCondition(config.accountToken !== config.noncontactToken,
    'blocked', 'account_tokens_not_distinct');
  return config;
}

function createTransport(fetchImpl, now, report) {
  const deadline = now() + TOTAL_TIMEOUT_MS;
  async function get(url, headers, label, kind = 'blocked', redirect = 'error') {
    requireCondition(report.requestCount < MAX_REQUESTS, kind, 'request_budget_exhausted');
    const remaining = deadline - now();
    requireCondition(remaining > 0, kind, 'time_budget_exhausted');
    report.requestCount += 1;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect, credentials: 'omit',
        headers, signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
      });
    } catch { throw new ProbeFailure(kind, label + '_transport_error'); }
    requireCondition(response && typeof response.status === 'number'
      && response.headers && !response.redirected, kind, label + '_response_invalid');
    requireCondition(!response.url || response.url === url, kind, label + '_response_url_mismatch');
    report.statuses.push({ check: label, status: response.status });
    return response;
  }
  async function text(response, limit, label, kind) {
    const declared = response.headers.get('content-length');
    requireCondition(declared === null || (/^\d+$/.test(declared) && Number(declared) <= limit),
      kind, label + '_body_limit');
    requireCondition(response.body && typeof response.body.getReader === 'function',
      kind, label + '_body_missing');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let result = '';
    try {
      while (true) {
        requireCondition(now() < deadline, kind, 'time_budget_exhausted');
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        requireCondition(size <= limit, kind, label + '_body_limit');
        result += decoder.decode(chunk.value, { stream: true });
      }
      result += decoder.decode();
      return result;
    } catch (error) {
      try { await reader.cancel(); } catch {}
      if (error instanceof ProbeFailure) throw error;
      throw new ProbeFailure(kind, label + '_body_read_failed');
    } finally { reader.releaseLock(); }
  }
  async function json(response, label, kind = 'blocked', limit = JSON_BYTES) {
    requireCondition(/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(
      response.headers.get('content-type') ?? ''), kind, label + '_json_required');
    const content = await text(response, limit, label, kind);
    try { return JSON.parse(content); } catch { throw new ProbeFailure(kind, label + '_json_invalid'); }
  }
  return { get, text, json };
}

function githubHeaders(config) {
  return { accept: 'application/vnd.github+json', authorization: 'Bearer ' + config.githubToken,
    'x-github-api-version': '2022-11-28' };
}
async function githubJson(path, label, config, transport) {
  const response = await transport.get(GITHUB_ORIGIN + '/repos/' + REPOSITORY + path,
    githubHeaders(config), label);
  requireCondition(response.status === 200, 'blocked', label + '_unavailable');
  return transport.json(response, label);
}
function signedLogLocation(value) {
  let url;
  try { url = new URL(value); } catch { throw new ProbeFailure('blocked', 'github_log_location_invalid'); }
  requireCondition(url.protocol === 'https:' && !url.username && !url.password && !url.port
    && !url.hash && url.search.length > 1
    && (/^[a-z0-9-]+\.blob\.core\.windows\.net$/i.test(url.hostname)
      || url.hostname === 'results-receiver.actions.githubusercontent.com'),
  'blocked', 'github_log_location_invalid');
  return url.href;
}
async function verifyDelivery(config, transport) {
  const run = await githubJson('/actions/runs/' + config.runId, 'delivery_run', config, transport);
  requireCondition(object(run) && run.id === config.runId && run.repository?.full_name === REPOSITORY
    && run.head_repository?.full_name === REPOSITORY && run.path === WORKFLOW
    && run.event === 'workflow_dispatch' && run.head_branch === 'main'
    && run.status === 'completed' && run.conclusion === 'success'
    && run.head_sha === config.expectedSha
    && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0,
  'blocked', 'canonical_delivery_not_verified');
  const jobs = await githubJson('/actions/runs/' + config.runId + '/attempts/' + run.run_attempt
    + '/jobs?per_page=100', 'delivery_jobs', config, transport);
  requireCondition(object(jobs) && Array.isArray(jobs.jobs)
    && jobs.total_count === jobs.jobs.length && jobs.jobs.length <= 100,
  'blocked', 'delivery_jobs_incomplete');
  const matches = jobs.jobs.filter((entry) => entry.name === DEPLOY_JOB);
  requireCondition(matches.length === 1, 'blocked', 'delivery_job_ambiguous');
  const job = matches[0];
  const requiredSteps = ['Require canonical main dispatch', 'Checkout exact canonical source',
    'Verify exact source SHA', 'Apply production D1 migrations', 'Deploy production Worker',
    'Verify public production health', 'Write production provenance', 'Upload production delivery provenance'];
  requireCondition(job.run_id === config.runId && job.head_sha === config.expectedSha
    && Number.isSafeInteger(job.id) && job.id > 0
    && job.status === 'completed' && job.conclusion === 'success'
    && Array.isArray(job.steps) && requiredSteps.every((name) =>
      job.steps.filter((step) => step.name === name && step.status === 'completed'
        && step.conclusion === 'success').length === 1),
  'blocked', 'delivery_job_not_verified');
  const redirect = await transport.get(GITHUB_ORIGIN + '/repos/' + REPOSITORY
    + '/actions/jobs/' + job.id + '/logs', githubHeaders(config), 'delivery_log_redirect', 'blocked', 'manual');
  requireCondition(redirect.status === 302, 'blocked', 'delivery_log_redirect_unavailable');
  const location = signedLogLocation(redirect.headers.get('location'));
  try { await redirect.body?.cancel(); } catch {}
  // Only the trusted GitHub response may select this URL. Never forward any token.
  const response = await transport.get(location, { accept: 'text/plain' }, 'delivery_log');
  requireCondition(response.status === 200, 'blocked', 'delivery_log_unavailable');
  const log = await transport.text(response, LOG_BYTES, 'delivery_log', 'blocked');
  const lines = log.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ''));
  const sourceIndex = lines.findIndex((line) => line === '[command]/usr/bin/git log -1 --format=%H');
  const versions = lines.map((line) => /^Current Version ID: ([a-f0-9-]{36})$/i.exec(line))
    .filter(Boolean).map((match) => match[1].toLowerCase());
  requireCondition(sourceIndex >= 0 && lines[sourceIndex + 1] === config.expectedSha
    && lines.some((line) => line.startsWith('Uploaded ' + WORKER + ' ('))
    && lines.some((line) => line.startsWith('Deployed ' + WORKER + ' triggers ('))
    && versions.length === 1 && UUID.test(versions[0]),
  'blocked', 'delivery_log_source_binding_missing');
  return { repository: REPOSITORY, sourceSha: run.head_sha, runId: run.id,
    runAttempt: run.run_attempt, jobId: job.id, worker: WORKER, workerVersionId: versions[0],
    completeLogSha256: createHash('sha256').update(log).digest('hex') };
}
async function cloudflareJson(path, label, config, transport) {
  const response = await transport.get(CLOUDFLARE_ORIGIN + '/client/v4/accounts/'
    + config.cfAccountId + path, { accept: 'application/json', authorization: 'Bearer ' + config.cfToken }, label);
  requireCondition(response.status === 200, 'blocked', label + '_unavailable');
  const body = await transport.json(response, label);
  requireCondition(object(body) && body.success === true && Array.isArray(body.errors)
    && body.errors.length === 0, 'blocked', label + '_unsuccessful');
  return body;
}
async function verifyActiveWorker(delivery, config, transport, suffix) {
  const domains = await cloudflareJson('/workers/domains?hostname=api.ombhrum.com',
    'worker_domain_' + suffix, config, transport);
  requireCondition(Array.isArray(domains.result) && domains.result.length === 1
    && domains.result[0].hostname === 'api.ombhrum.com'
    && domains.result[0].service === WORKER && domains.result[0].enabled === true
    && domains.result[0].environment === 'production',
  'blocked', 'live_worker_domain_mismatch');
  const deployments = await cloudflareJson('/workers/scripts/' + WORKER + '/deployments?per_page=1',
    'worker_deployment_' + suffix, config, transport);
  // Cloudflare documents the first result as the deployment actively serving traffic.
  const active = deployments.result?.deployments?.[0];
  requireCondition(object(active) && UUID.test(active.id ?? '')
    && active.strategy === 'percentage' && Array.isArray(active.versions)
    && active.versions.length === 1 && active.versions[0].percentage === 100
    && active.versions[0].version_id === delivery.workerVersionId,
  'blocked', 'live_worker_version_mismatch');
  return active.id;
}

function messageUrl(peerId, afterId, pageSize) {
  const url = new URL('/api/social/messages', MESSAGE_ORIGIN);
  url.searchParams.set('contactId', String(peerId));
  url.searchParams.set('afterId', String(afterId));
  url.searchParams.set('limit', String(pageSize));
  return url.href;
}
function accountHeaders(value) {
  return { accept: 'application/json', ...(value ? { authorization: 'Bearer ' + value } : {}) };
}
async function verifyIdentity(value, expectedId, label, transport) {
  const response = await transport.get(MESSAGE_ORIGIN + '/api/auth/user-info',
    accountHeaders(value), label, 'failed');
  requireCondition(response.status === 200, 'blocked', label + '_credential_unavailable');
  const body = await transport.json(response, label, 'failed', 64 * 1024);
  const id = object(body) && (typeof body.id === 'number' || typeof body.id === 'string') ? Number(body.id) : NaN;
  requireCondition(Number.isSafeInteger(id) && id === expectedId
    && body.role === 'user' && body.isAdmin === false,
  'failed', label + '_identity_mismatch');
}
async function verifyDenial(value, expectedStatus, label, config, transport) {
  const response = await transport.get(messageUrl(config.fixture.peerUserId, 0, config.fixture.pageSize),
    accountHeaders(value), label, 'failed');
  requireCondition(response.status === expectedStatus, 'failed', label + '_status_mismatch');
  const body = await transport.json(response, label, 'failed', 8192);
  requireCondition(object(body) && body.success === false && body.error
    && !Object.hasOwn(body, 'data') && !Object.hasOwn(body, 'messages'),
  'failed', label + '_error_contract_invalid');
}
async function readPage(peerId, cursor, expectedIds, offset, label, config, transport, report) {
  const response = await transport.get(messageUrl(peerId, cursor, config.fixture.pageSize),
    accountHeaders(config.accountToken), label, 'failed');
  requireCondition(response.status === 200, 'failed', label + '_status_mismatch');
  const body = await transport.json(response, label, 'failed');
  const data = body?.data;
  requireCondition(body?.success === true && object(data) && object(data.contact)
    && data.contact.id === peerId && data.contact.userId === peerId
    && object(data.historyCursor) && data.historyCursor.mode === 'after-id'
    && data.historyCursor.afterId === cursor && Array.isArray(data.messages)
    && data.messages.length <= config.fixture.pageSize,
  'failed', 'history_page_contract_invalid');
  let previous = cursor;
  for (const [index, message] of data.messages.entries()) {
    requireCondition(object(message) && Number.isSafeInteger(message.id) && message.id > previous,
      'failed', 'history_id_order_invalid');
    requireCondition((message.senderUserId === config.fixture.actorUserId && message.recipientUserId === peerId)
      || (message.senderUserId === peerId && message.recipientUserId === config.fixture.actorUserId),
    'failed', 'history_participant_scope_invalid');
    requireCondition(message.isOutgoing === (message.senderUserId === config.fixture.actorUserId),
      'failed', 'history_actor_projection_invalid');
    requireCondition(message.id === expectedIds[offset + index], 'failed', 'history_fixture_mismatch');
    previous = message.id;
  }
  requireCondition(data.nextAfterId === (data.messages.length ? previous : cursor),
    'failed', 'history_next_cursor_invalid');
  report.pages.push({ check: label, afterOrdinal: offset, nextOrdinal: offset + data.messages.length,
    count: data.messages.length, empty: data.messages.length === 0 });
  return { nextAfterId: data.nextAfterId, count: data.messages.length };
}
async function traverse(startIndex, label, config, transport, report) {
  const expected = config.fixture.expectedMessageIds;
  let offset = startIndex;
  let cursor = startIndex === 0 ? 0 : expected[startIndex - 1];
  let checkpoint = null;
  let nonemptyPages = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await readPage(config.fixture.peerUserId, cursor, expected, offset,
      label, config, transport, report);
    if (result.count === 0) {
      requireCondition(offset === expected.length, 'failed', 'history_ended_before_fixture');
      return { checkpoint, nonemptyPages, readCount: offset - startIndex };
    }
    offset += result.count;
    cursor = result.nextAfterId;
    nonemptyPages += 1;
    if (checkpoint === null) checkpoint = offset;
  }
  throw new ProbeFailure('failed', 'history_page_budget_exhausted');
}

/**
 * The production path and injected-fetch tests use the same provenance and history
 * code. Test injection replaces transport only; there is no trusted-provenance stub.
 */
export async function runFromEnvironment(env, { fetchImpl = fetch, now = Date.now } = {}) {
  const report = { schemaVersion: 1, status: 'blocked', reasonCodes: [], requestCount: 0,
    statuses: [], pages: [], productionAcceptance: 'not-established',
    recoveryScope: 'client-readonly-checkpoint-reread', durableClientRestart: 'not-verified',
    remoteD1Recovery: 'not-verified', independentAccept: 'not-verified' };
  try {
    const config = readConfig(env);
    report.checkSourceSha = config.checkSourceSha;
    const transport = createTransport(fetchImpl, now, report);
    const delivery = await verifyDelivery(config, transport);
    const deploymentId = await verifyActiveWorker(delivery, config, transport, 'before');
    report.source = { ...delivery, deploymentId, controlPlaneChecks: 'before-only' };
    await verifyDenial(null, 401, 'anonymous_denial', config, transport);
    await verifyIdentity(config.accountToken, config.fixture.actorUserId, 'actor', transport);
    await verifyIdentity(config.noncontactToken, config.fixture.noncontactUserId, 'noncontact_actor', transport);
    await verifyDenial(config.noncontactToken, 403, 'noncontact_denial', config, transport);
    const initial = await traverse(0, 'origin_traversal', config, transport, report);
    requireCondition(initial.nonemptyPages >= 2 && initial.checkpoint > 0,
      'failed', 'history_multipage_not_observed');
    const empty = await readPage(config.fixture.emptyPeerUserId, 0, [], 0,
      'empty_origin', config, transport, report);
    requireCondition(empty.count === 0 && empty.nextAfterId === 0, 'failed', 'empty_origin_not_empty');
    const resumed = await traverse(initial.checkpoint, 'checkpoint_reread', config, transport, report);
    requireCondition(resumed.readCount === config.fixture.expectedMessageIds.length - initial.checkpoint,
      'failed', 'checkpoint_reread_incomplete');
    const finalDeploymentId = await verifyActiveWorker(delivery, config, transport, 'after');
    requireCondition(finalDeploymentId === deploymentId, 'blocked', 'active_deployment_changed_during_probe');
    report.source.controlPlaneChecks = 'before-and-after';
    report.counts = { expectedMessages: config.fixture.expectedMessageIds.length,
      observedMessages: initial.readCount, nonemptyPages: initial.nonemptyPages,
      checkpointOrdinal: initial.checkpoint, rereadMessages: resumed.readCount };
    report.status = 'passed';
    report.productionAcceptance = 'named-readonly-fixture-checks-only';
  } catch (error) {
    report.status = error instanceof ProbeFailure ? error.kind : 'failed';
    report.reasonCodes = [error instanceof ProbeFailure ? error.code : 'unexpected_probe_failure'];
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runFromEnvironment(process.env);
  const directory = 'artifacts/human-messaging-production-readiness';
  await mkdir(directory, { recursive: true });
  await writeFile(directory + '/report.json', JSON.stringify(report, null, 2) + '\n');
  console.log('Read-only Human message probe: ' + report.status
    + (report.reasonCodes.length ? ' (' + report.reasonCodes.join(',') + ')' : ''));
  if (report.status !== 'passed') process.exitCode = report.status === 'blocked' ? 2 : 1;
}
