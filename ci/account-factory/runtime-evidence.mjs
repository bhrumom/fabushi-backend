import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const requiredAssertions = Object.freeze(['oidcInvalidRejected', 'realRegistrationAndLogin', 'crossRunCleanupDenied', 'sameAccountMultiSession', 'crossAccountIdentitySpoofDenied', 'canonicalArgon2id', 'canonicalRS256', 'crossAccountPasswordDenied', 'refreshRotation', 'sessionRevocation', 'otherSessionRetained', 'expiredSessionDenied', 'zeroResidualCleanup', 'deletedSessionDenied', 'ttlReclamation', 'nativeFileIssuedSessionConvergence', 'nativeFileAccountIsolation', 'nativeFileConflictPreserved', 'nativeFileRevokedSessionDenied', 'nativeFileExpiredSessionDenied', 'nativeFileDeletedSessionDenied', 'nativeFileZeroResidualCleanup']);
export function validateRuntimeEvidence(report, expected) {
  if (report?.kind !== 'canonical-worker-runtime-integration' || report.overall !== 'PASS' || report.cleanup === 'blocked' ||
      report.backendSha !== expected.backendSha || report.coreSha !== expected.coreSha || report.runId !== expected.runId || report.runAttempt !== expected.runAttempt ||
      report.wasmSha256 !== expected.wasmSha256 || !/^[a-f0-9]{64}$/.test(report.wasmSha256 || '') ||
      report.d1Mode !== 'emulated-local' || report.hostedFixtureService !== 'NOT_VERIFIED' || report.packagedCrossDeviceE2E !== 'NOT_VERIFIED' ||
      report.testCount !== requiredAssertions.length || !report.assertions || Object.keys(report.assertions).length !== requiredAssertions.length || requiredAssertions.some(id => report.assertions[id] !== 'PASS')) throw Error('runtime_evidence_rejected');
  return { status: 'PASS', testCount: requiredAssertions.length, scope: 'canonical-worker-with-emulated-D1' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = { backendSha: process.env.GITHUB_SHA, coreSha: process.env.CORE_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, wasmSha256: createHash('sha256').update(readFileSync('core/deploy/platform-worker/build/worker/index.wasm')).digest('hex') };
  console.log(JSON.stringify(validateRuntimeEvidence(JSON.parse(readFileSync('evidence/runtime.json', 'utf8')), expected)));
}
