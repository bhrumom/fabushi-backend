// Explicit administrator configuration, not a Worker startup or test-key path.
import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.argv[2] !== '--initialize-managed-identity') {
  throw new Error('Explicit --initialize-managed-identity is required');
}
const gh = process.env.GH_BIN || 'gh';
const repo = 'bhrumom/fabushi-backend';
const names = ['FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY', 'FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW',
  'FABUSHI_MARKETPLACE_SIGNING_KEY_ID', 'FABUSHI_MARKETPLACE_TRUST_EPOCH', 'FABUSHI_MARKETPLACE_REVIEW_TOKEN'];
function invoke(args, input) {
  const r = spawnSync(gh, args, { input, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0 || r.error) throw new Error('GitHub configuration operation failed; output withheld');
  return r.stdout;
}
const current = JSON.parse(invoke(['api', `repos/${repo}/environments/production/secrets`])).secrets;
if (current.some(s => names.includes(s.name))) throw new Error('Existing/partial signing identity: refuse overwrite or rotation');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicRaw = publicKey.export({ format: 'jwk' }).x;
const keyId = 'fabushi-marketplace-managed-20261013-1';
const values = [privateKey.export({ type: 'pkcs8', format: 'pem' }), publicRaw, keyId, '1', randomBytes(32).toString('base64url')];
let written = 0;
try {
  for (let i = 0; i < names.length; i++) {
    invoke(['secret', 'set', names[i], '--repo', repo, '--env', 'production'], values[i]);
    written++;
  }
} catch {
  throw new Error(`Partial encrypted configuration (${written}/5). Do not regenerate or overwrite; administrator recovery required.`);
}
console.log(JSON.stringify({ configured: names, keyId, trustEpoch: 1, rawPublicKeyBase64URL: publicRaw,
  publicKeyFingerprint: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex') }));
