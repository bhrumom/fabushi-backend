import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

// Execute the real report-builder source embedded in the production probe. This
// deliberately tests verdict behavior without running the root-only live probe.
const probe = readFileSync(new URL('./probe-official-device-mcp-g15.sh', import.meta.url), 'utf8');
const match = probe.match(/python3 - "\$output" <<'PY'\n([\s\S]*?)\nPY\n/);
assert.ok(match, 'production probe must contain its Python report builder');
const verdictSource = match[1];

const base = {
  FDN_MCP_BACKEND_SHA: 'a'.repeat(40),
  FDN_MCP_CORE_SHA: 'b'.repeat(40),
  FDN_MCP_ELAPSED_NS: '300000000000',
  FDN_MCP_DELTA_TICKS: '150',
  FDN_MCP_CLOCK_TICKS: '100',
  FDN_MCP_MAX_RSS: '100000000',
  FDN_MCP_RSS_LIMIT: String(150 * 1024 * 1024),
  FDN_MCP_MAX_STATE: '1048576',
  FDN_MCP_STATE_LIMIT: String(20 * 1024 * 1024),
  FDN_MCP_MAX_AUDIT: '1048576',
  FDN_MCP_JOURNAL_BYTES: '1048576',
  FDN_MCP_LOG_LIMIT: String(20 * 1024 * 1024),
  FDN_MCP_FS_TOTAL: String(100 * 1024 * 1024 * 1024),
  FDN_MCP_FS_AVAILABLE: String(10 * 1024 * 1024 * 1024),
  FDN_MCP_FS_RESERVE: String(5 * 1024 * 1024 * 1024),
  FDN_MCP_PRIVACY_SCAN: 'pass',
  FDN_MCP_EGRESS_START: '10',
  FDN_MCP_EGRESS_END: '10',
  FDN_MCP_EGRESS_REJECTED: '0',
};

function evaluate(t, overrides, expectedStatus, expectedExitCode) {
  const dir = mkdtempSync(join(tmpdir(), 'fdn-g15-verdict-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const output = join(dir, 'report.json');
  const result = spawnSync('python3', ['-c', verdictSource, output], {
    encoding: 'utf8',
    env: {...process.env, ...base, ...overrides},
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expectedExitCode, result.stderr || result.stdout);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.status, expectedStatus);
  assert.equal(report.exitCode, expectedExitCode);
  return report;
}

test('PASS requires a present egress owner, zero rejects, passing privacy, and every budget', t => {
  const report = evaluate(t, {}, 'PASS', 0);
  assert.equal(report.unexpectedWorkerOwnedPacketsRejected, 0);
  assert.equal(report.egress.counterOwner !== null, true);
  assert.equal(report.egress.pass, true);
  for (const budget of Object.values(report.budgets)) assert.equal(budget.pass, true);
});

test('missing egress counter owner/count is BLOCKED, never PASS', t => {
  const report = evaluate(t, {
    FDN_MCP_EGRESS_START: '',
    FDN_MCP_EGRESS_END: '',
    FDN_MCP_EGRESS_REJECTED: '',
  }, 'BLOCKED_EGRESS_REJECT_COUNTER', 78);
  assert.equal(report.unexpectedWorkerOwnedPacketsRejected, null);
  assert.equal(report.egress.counterOwner, null);
  assert.equal(report.egress.pass, false);
});

test('zero count without both counter snapshots is BLOCKED', t => {
  const report = evaluate(t, {
    FDN_MCP_EGRESS_START: '',
    FDN_MCP_EGRESS_END: '',
    FDN_MCP_EGRESS_REJECTED: '0',
  }, 'BLOCKED_EGRESS_REJECT_COUNTER', 78);
  assert.equal(report.unexpectedWorkerOwnedPacketsRejected, 0);
  assert.equal(report.egress.counterOwner, null);
  assert.equal(report.egress.pass, false);
});

test('counter delta inconsistent with snapshots fails closed', t => {
  const report = evaluate(t, {
    FDN_MCP_EGRESS_START: '10',
    FDN_MCP_EGRESS_END: '11',
    FDN_MCP_EGRESS_REJECTED: '0',
  }, 'FAIL', 1);
  assert.equal(report.egress.counterOwner !== null, true);
  assert.equal(report.egress.pass, false);
});

test('observed privacy failure is not hidden by a missing egress sample', t => {
  const report = evaluate(t, {
    FDN_MCP_PRIVACY_SCAN: 'fail',
    FDN_MCP_EGRESS_START: '',
    FDN_MCP_EGRESS_END: '',
    FDN_MCP_EGRESS_REJECTED: '',
  }, 'FAIL', 1);
  assert.equal(report.privacy.journalSecretScan, 'fail');
  assert.equal(report.egress.counterOwner, null);
});

test('nonzero unexpectedWorkerOwnedPacketsRejected fails', t => {
  const report = evaluate(t, {
    FDN_MCP_EGRESS_START: '10',
    FDN_MCP_EGRESS_END: '11',
    FDN_MCP_EGRESS_REJECTED: '1',
  }, 'FAIL', 1);
  assert.equal(report.unexpectedWorkerOwnedPacketsRejected, 1);
  assert.equal(report.egress.pass, false);
});

test('privacy scan failure fails', t => {
  const report = evaluate(t, {FDN_MCP_PRIVACY_SCAN: 'fail'}, 'FAIL', 1);
  assert.equal(report.privacy.journalSecretScan, 'fail');
});

for (const [name, overrides] of [
  ['RSS at the exclusive limit', {FDN_MCP_MAX_RSS: String(150 * 1024 * 1024)}],
  ['CPU at the exclusive limit', {FDN_MCP_DELTA_TICKS: '300'}],
  ['state budget exceeded', {FDN_MCP_MAX_STATE: String(20 * 1024 * 1024 + 1)}],
  ['audit budget exceeded', {FDN_MCP_MAX_AUDIT: String(20 * 1024 * 1024 + 1)}],
  ['journal budget exceeded', {FDN_MCP_JOURNAL_BYTES: String(20 * 1024 * 1024 + 1)}],
  ['disk reserve below required threshold', {
    FDN_MCP_FS_AVAILABLE: String(5 * 1024 * 1024 * 1024 - 1),
    FDN_MCP_FS_RESERVE: String(5 * 1024 * 1024 * 1024),
  }],
]) {
  test(`resource gate fails: ${name}`, t => {
    const report = evaluate(t, overrides, 'FAIL', 1);
    assert.notEqual(report.status, 'PASS');
  });
}
