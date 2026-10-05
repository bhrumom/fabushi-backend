import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..', '..');
const workflow = readFileSync(join(repoRoot, '.github/workflows/production-worker-delivery.yml'), 'utf8');
const secretGuard = readFileSync(join(repoRoot, '.github/scripts/assert-worker-security-secrets.sh'), 'utf8');
const migrationGuard = readFileSync(join(repoRoot, '.github/scripts/run-wrangler-d1-migrations.sh'), 'utf8');
const spec = readFileSync(join(repoRoot, 'docs/specs/production-worker-delivery.md'), 'utf8');
const wrangler = readFileSync(join(webRoot, 'wrangler.toml'), 'utf8');

test('production delivery is manual, canonical-main-only, and GitHub Actions owned', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /actions\/checkout@v5/);
  assert.match(workflow, /github\.sha/);
  assert.match(spec, /legacy `bhrumom\/fabushi`.*must not perform this deployment/i);
});

test('production delivery fails closed on Cloudflare identity and remote Worker secrets', () => {
  assert.match(workflow, /CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(workflow, /assert-worker-security-secrets\.sh production/);
  for (const name of [
    'JWT_SIGNING_SECRET', 'ADMIN_EMAILS', 'ALIPAY_PRIVATE_KEY',
    'AUTH_PROVIDER_BRIDGE_SECRET', 'APPLE_ISSUER_ID', 'APPLE_KEY_ID',
    'APPLE_PRIVATE_KEY', 'APPLE_BUNDLE_ID', 'FIREBASE_PROJECT_ID',
  ]) assert.ok(secretGuard.includes(name), `missing required production secret ${name}`);
  assert.match(secretGuard, /wrangler@latest secret list --env/);
});

test('D1 migration is bounded and ordered before deploy, smoke, and provenance', () => {
  const migrate = workflow.indexOf('run-wrangler-d1-migrations.sh DB production');
  const deploy = workflow.indexOf('wrangler@4 deploy --env production');
  const health = workflow.indexOf('https://api.ombhrum.com/health');
  const artifact = workflow.indexOf('actions/upload-artifact@v4');
  assert.ok(migrate >= 0 && deploy > migrate && health > deploy && artifact > health);
  assert.match(migrationGuard, /WRANGLER_D1_MAX_ATTEMPTS:-4/);
  assert.match(migrationGuard, /non-retryable error/);
  assert.match(migrationGuard, /d1 migrations apply.*--remote/s);
});

test('production bindings and public smoke origin are canonical', () => {
  assert.match(wrangler, /name = "fabushi-flutter-web-prod"/);
  assert.match(wrangler, /database_name = "fabushi-db"/);
  assert.match(wrangler, /bucket_name = "bushi"/);
  assert.match(wrangler, /pattern = "api\.ombhrum\.com"/);
  assert.match(workflow, /production-worker-delivery-provenance\.json/);
  assert.match(workflow, /sourceSha/);
  assert.match(workflow, /runAttempt/);
});
