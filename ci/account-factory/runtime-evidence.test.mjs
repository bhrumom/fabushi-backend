import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredAssertions, validateRuntimeEvidence } from './runtime-evidence.mjs';
const expected = { backendSha: 'a'.repeat(40), coreSha: 'b'.repeat(40), runId: '123', runAttempt: '1', wasmSha256: 'c'.repeat(64) };
const report = { ...expected, kind: 'canonical-worker-runtime-integration', overall: 'PASS', d1Mode: 'emulated-local', hostedFixtureService: 'NOT_VERIFIED', packagedCrossDeviceE2E: 'NOT_VERIFIED', testCount: requiredAssertions.length, assertions: Object.fromEntries(requiredAssertions.map(id => [id, 'PASS'])) };
test('independent runtime validator accepts exactly its expected assertions/source/compiled digest', () => assert.equal(validateRuntimeEvidence(report, expected).testCount, 15));
for (const change of [{ cleanup: 'blocked' }, { overall: 'FAIL' }, { backendSha: 'd'.repeat(40) }, { coreSha: 'd'.repeat(40) }, { wasmSha256: 'd'.repeat(64) }, { testCount: 0 }, { assertions: {} }, { assertions: { ...report.assertions, sessionRevocation: 'NOT_VERIFIED' } }, { d1Mode: 'production' }, { hostedFixtureService: 'PASS' }, { runId: '999' }]) {
  test(`independent runtime evidence rejects ${JSON.stringify(change)}`, () => assert.throws(() => validateRuntimeEvidence({ ...report, ...change }, expected), /runtime_evidence_rejected/));
}
