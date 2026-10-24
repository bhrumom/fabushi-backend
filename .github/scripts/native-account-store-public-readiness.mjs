import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function checkNativeAccountStorePublic(fetchImpl = fetch) {
  const checks = [];
  for (const origin of ['https://api.ombhrum.com', 'https://ai.ombhrum.com']) {
    for (const path of ['/v1/account/agents', '/v1/account/agents/readiness-probe', '/v1/account/agents/readiness-probe/store', '/v1/account/bots', '/v1/account/sync']) {
      const response = await fetchImpl(origin + path, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json' },
      });
      assert.equal(response.status, 401, `Native account boundary status for ${origin}${path}`);
      assert.equal(response.headers.get('location'), null, 'Private account route must not redirect');
      assert.ok(response.headers.get('content-type')?.includes('application/json'), 'Expected native JSON error');
      const owner = response.headers.get('x-fabushi-agent-store-owner');
      if (origin === 'https://api.ombhrum.com') {
        assert.equal(owner, 'existing-node-account-store', 'Expected existing account store gateway owner');
        assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
      }
      // Consume only bounded error metadata, never record response content.
      const body = await response.json();
      assert.ok(body && typeof body === 'object' && body.error, 'Expected native authorization error');
      checks.push({ origin, path, status: response.status, owner });
    }
  }
  return checks;
}

export async function checkNativeJournalPublic(fetchImpl = fetch) {
  const checks = [];
  const origin = 'https://api.ombhrum.com';
  for (const [method, path] of [
    ['GET', '/v1/automation-runs/readiness-probe'], ['GET', '/v1/ai/usage'],
    ['POST', '/v1/automation-runs'], ['POST', '/v1/automation-runs/complete'], ['POST', '/v1/automation-events/poll'],
    ['GET', '/v1/automations'], ['GET', '/v1/automations/readiness-probe'],
    ['PUT', '/v1/automations/readiness-probe'], ['DELETE', '/v1/automations/readiness-probe'],
  ]) {
    const response = await fetchImpl(origin + path, {
      method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
      ...(method !== 'GET' ? { body: '{}' } : {}),
    });
    assert.equal(response.status, 401, `Native journal credential boundary for ${method} ${path}`);
    assert.equal(response.headers.get('location'), null);
    assert.ok(response.headers.get('content-type')?.includes('application/json'));
    assert.equal(response.headers.get('x-fabushi-control-plane'), 'mahayana-platform');
    const body = await response.json();
    assert.ok(body && typeof body === 'object' && body.error);
    checks.push({ origin, path, method, status: response.status, owner: 'mahayana-platform' });
  }
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checks = await checkNativeAccountStorePublic();
  const journalChecks = await checkNativeJournalPublic();
  await writeFile('native-account-store-public-readiness.json', JSON.stringify({
    checkSourceSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
    checks, journalChecks, result: 'passed', scope: 'public route ownership and anonymous refusal only',
    authenticatedJournalParity: 'not-verified-in-production',
    authenticatedFileParity: 'not-verified', desktopCutover: 'not-verified',
  }, null, 2) + '\n');
}
