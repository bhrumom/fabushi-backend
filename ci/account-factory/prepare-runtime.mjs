// Run exclusively in the disposable GitHub Actions runtime job.
import { generateKeyPairSync, randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) throw Error('actions_only');
const dir = join(process.env.RUNNER_TEMP, 'account-worker');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const vars = {
  ACCESS_TOKEN_KEY_ID: `ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  ACCESS_TOKEN_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  ACCESS_TOKEN_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }),
  AUTH_PUBLIC_BASE_URL: 'https://127.0.0.1:9443',
  AUTH_REGISTRATION_BRIDGE_URL: 'http://127.0.0.1:9444',
  AUTH_PROVIDER_BRIDGE_SECRET: randomBytes(32).toString('hex'),
};
const cfg = { name: 'fabushi-ci-isolated-local', main: resolve('core/deploy/platform-worker/build/worker/shim.mjs'), compatibility_date: '2026-07-18', vars, d1_databases: [
  { binding: 'ACCOUNT_DB', database_name: 'ci-account-db', database_id: randomUUID() },
  { binding: 'PLATFORM_DB', database_name: 'ci-platform-db', database_id: randomUUID() },
] };
writeFileSync(join(dir, 'wrangler.json'), JSON.stringify(cfg), { mode: 0o600 });
writeFileSync(join(dir, 'worker-vars.json'), JSON.stringify(vars), { mode: 0o600 });
