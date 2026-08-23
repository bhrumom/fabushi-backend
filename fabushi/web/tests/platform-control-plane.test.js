import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.resolve(root, relative), 'utf8');

const router = read('src/router.js');
assert.ok(router.split(/\r?\n/).length <= 80, 'web router must remain an orchestrator');
assert.doesNotMatch(router, /leaderboard/i, 'retired leaderboard must not return to active routing');
assert.doesNotMatch(router, /handlers\//, 'top-level web router must not import feature handlers directly');
for (const domain of [
  'platform-gateway-routes',
  'core-routes',
  'auth-routes',
  'membership-routes',
  'commerce-routes',
  'community-routes',
  'content-routes',
  'ops-routes',
  'legacy-practice-routes',
]) {
  assert.match(router, new RegExp(domain), `missing bounded route module ${domain}`);
}
assert.ok(
  router.indexOf('routePlatformGateway') < router.indexOf('routeAuthRequest'),
  'canonical Mahayana gateway must run before legacy account routes',
);

const gateway = read('src/routes/platform-gateway-routes.js');
assert.match(gateway, /https:\/\/mahayana-platform\.bhrumom\.workers\.dev/, 'gateway needs an explicit canonical upstream');
assert.match(gateway, /pathname\.startsWith\('\/api\/auth\/browser\/'\)/, 'browser-first auth must always route through the Mahayana control plane');
assert.match(gateway, /pathname\.startsWith\('\/v1\/'\)/, 'all v1 platform APIs must go to the Rust control plane');
assert.match(gateway, /redirect: 'manual'/, 'OAuth redirects must be returned to the browser, not followed by the gateway');
assert.match(gateway, /X-Fabushi-Control-Plane/, 'proxied browser auth must identify the canonical control plane');
assert.match(gateway, /env\.MAHAYANA_PLATFORM\.fetch\(request\)/, 'same-account platform forwarding must prefer the Cloudflare service binding');

const workerWrangler = read('wrangler.toml');
for (const environment of ['production', 'development']) {
  assert.match(
    workerWrangler,
    new RegExp(`\\[\\[env\\.${environment}\\.services\\]\\][\\s\\S]*?binding = "MAHAYANA_PLATFORM"[\\s\\S]*?service = "mahayana-platform"`),
    `${environment} must bind the Mahayana platform Worker internally`,
  );
}

const requestGate = read('src/security/request-gate.js');
assert.doesNotMatch(requestGate, /TRANSFER_RECEIPT_SECRET|leaderboard/i, 'retired leaderboard gate must stay removed');

const secrets = read('../../.github/scripts/assert-worker-security-secrets.sh');
assert.doesNotMatch(secrets, /TRANSFER_RECEIPT_SECRET/, 'retired leaderboard secret must not remain a deployment requirement');

const endpoints = read('../../frontend/packages/api-client/src/endpoints.ts');
assert.doesNotMatch(endpoints, /leaderboard/i, 'retired leaderboard client endpoint must stay removed');
assert.match(endpoints, /\/api\/auth\/browser\/start/, 'client must expose canonical browser-first auth');
assert.match(endpoints, /https:\/\/api\.ombhrum\.com/, 'packaged API client must default to the stable public control-plane origin');

const marketingSources = [
  read('../../frontend/apps/web/src/app/page.tsx'),
  read('../../frontend/apps/web/src/lib/official-site-releases.ts'),
  read('../../frontend/packages/shared/src/app-experience.ts'),
].join('\n');
assert.doesNotMatch(marketingSources, /leaderboard|global-ranking/i, 'retired leaderboard must not return to active product or marketing data');

const platformWrangler = read('../../third_party/mahayana/mahayana-rs/mahayana-platform-worker/wrangler.toml');
assert.match(platformWrangler, /AUTH_PUBLIC_BASE_URL = "https:\/\/api\.ombhrum\.com"/, 'OAuth callback origin must use the stable public API domain');

const rustWorker = read('../../third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/worker_api.rs');
const rustWorkerBytes = Buffer.byteLength(rustWorker, 'utf8');
assert.ok(
  rustWorkerBytes <= 65000,
  `worker_api.rs is a shrinking migration budget and must not grow (got ${rustWorkerBytes} bytes)`,
);

const rustModuleRoot = '../../third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/worker_api';
for (const moduleName of ['account', 'ai_usage', 'commerce', 'listener_relay', 'marketplace', 'remote_computer', 'security']) {
  const moduleSource = read(`${rustModuleRoot}/${moduleName}.rs`);
  assert.doesNotMatch(moduleSource, /include!\(/, `${moduleName}.rs must be a real module, not another include seam`);
}
assert.doesNotMatch(rustWorker, /worker_api_parts|include!\(/, 'worker_api.rs must not retain transitional include seams');

const identityAuth = read('../../third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/identity_auth.rs');
assert.doesNotMatch(identityAuth, /offline_access/, 'sign-in gatekeepers must not request durable provider access');

const accountMigration = read('../../third_party/mahayana/mahayana-rs/mahayana-platform-worker/account-migrations/0005_principals_connections.sql');
const workspaceMigration = read('../../third_party/mahayana/mahayana-rs/mahayana-platform-worker/migrations/0007_workspace_messaging.sql');
for (const table of ['account_principals', 'account_contact_points', 'account_connections', 'account_connection_grants']) {
  assert.match(accountMigration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `missing ${table}`);
}
for (const table of ['platform_workspaces', 'platform_agents', 'platform_peers', 'platform_conversations', 'platform_messages']) {
  assert.match(workspaceMigration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `missing ${table}`);
}
assert.match(workspaceMigration, /UNIQUE \(conversation_id, seq\)/, 'messages need stable per-conversation ordering');
assert.match(workspaceMigration, /UNIQUE \(conversation_id, client_nonce\)/, 'message retries need idempotency');

console.log('Platform control-plane architecture guard passed.');
