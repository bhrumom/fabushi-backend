import { createPrivateKey, createPublicKey, sign, verify, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const names = ['FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY', 'FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW',
  'FABUSHI_MARKETPLACE_SIGNING_KEY_ID', 'FABUSHI_MARKETPLACE_TRUST_EPOCH', 'FABUSHI_MARKETPLACE_REVIEW_TOKEN'];

export function plan(env, existingNames) {
  if (env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'bhrumom/fabushi-backend') {
    throw new Error('Bootstrap requires canonical main/repository');
  }
  if (names.some(name => !env[name])) throw new Error('Encrypted environment signing configuration incomplete');
  const present = names.filter(name => existingNames.includes(name));
  if (present.length && present.length !== names.length) throw new Error('Partial remote identity: refuse mutation');
  if (present.length === names.length) return { action: 'preserve-existing' };
  const privateKey = createPrivateKey(env.FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 required');
  const publicKey = createPublicKey(privateKey);
  const raw = publicKey.export({ format: 'jwk' }).x;
  if (raw !== env.FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW) throw new Error('Signing key mismatch');
  const message = Buffer.from('Fabushi managed identity coherence');
  if (!verify(null, message, publicKey, sign(null, message, privateKey))) throw new Error('Key coherence failure');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(env.FABUSHI_MARKETPLACE_SIGNING_KEY_ID)
    || !/^[1-9][0-9]*$/.test(env.FABUSHI_MARKETPLACE_TRUST_EPOCH)
    || !Number.isSafeInteger(Number(env.FABUSHI_MARKETPLACE_TRUST_EPOCH))
    || !/^[A-Za-z0-9_-]{43}$/.test(env.FABUSHI_MARKETPLACE_REVIEW_TOKEN)) throw new Error('Invalid signing metadata');
  return { action: 'initialize', public: { keyId: env.FABUSHI_MARKETPLACE_SIGNING_KEY_ID,
    trustEpoch: Number(env.FABUSHI_MARKETPLACE_TRUST_EPOCH), rawPublicKeyBase64URL: raw,
    publicKeyFingerprint: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex') } };
}

function wrangler(args, input) {
  const r = spawnSync('npx', ['--yes', 'wrangler@4', 'secret', ...args, '--env', 'production'],
    { input, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0 || r.error) throw new Error('Cloudflare operation failed; raw output withheld');
  return r.stdout;
}
export function execute(env) {
  // Ref guard precedes even the remote read; plan rechecks it before mutation.
  if (env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'bhrumom/fabushi-backend') throw new Error('Canonical main required');
  const existing = JSON.parse(wrangler(['list', '--format', 'json'])).map(row => row.name);
  const operation = plan(env, existing);
  if (operation.action === 'initialize') {
    const data = Object.fromEntries(names.map(name => [name, env[name]]));
    wrangler(['bulk'], JSON.stringify(data));
    const after = JSON.parse(wrangler(['list', '--format', 'json'])).map(row => row.name);
    if (names.some(name => !after.includes(name))) throw new Error('Remote initialization not confirmed');
  }
  console.log(JSON.stringify({ ...operation, sourceSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    actor: env.GITHUB_ACTOR, worker: 'fabushi-flutter-web-prod' }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) execute(process.env);
