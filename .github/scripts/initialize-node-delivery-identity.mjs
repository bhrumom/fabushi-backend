// Administrator configuration only: no build/test/deploy on workstation.
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
if (!process.argv.includes('--initialize-restricted-node-delivery')) throw new Error('Explicit initialization required');
const gh = '/Users/bhrum/.local/bin/gh';
const repo = 'bhrumom/fabushi-backend';
function call(args, input) {
  const result = spawnSync(gh, args, { input, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0 || result.error) throw new Error('GitHub configuration failed; raw output withheld');
  return result.stdout;
}
const environment = JSON.parse(call(['api', `repos/${repo}/environments/production`]));
if (!environment.deployment_branch_policy?.custom_branch_policies) throw new Error('Production main-only branch policy required');
const rules = JSON.parse(call(['api', `repos/${repo}/environments/production/deployment-branch-policies`]));
if (rules.branch_policies.length !== 1 || rules.branch_policies[0].name !== 'main') throw new Error('Production must allow main only');
const names = JSON.parse(call(['api', `repos/${repo}/environments/production/secrets`])).secrets.map(s => s.name);
if (names.includes('FABUSHI_AI_DEPLOY_SSH_KEY')) throw new Error('Existing deployment identity preserved; refuse overwrite');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const jwk = publicKey.export({ format: 'jwk' });
function field(bytes) { const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); return Buffer.concat([size, bytes]); }
function integer(value) { const bytes = Buffer.from(value, 'base64url'); return field(bytes[0] & 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes); }
const publicSsh = 'ssh-rsa ' + Buffer.concat([field(Buffer.from('ssh-rsa')), integer(jwk.e), integer(jwk.n)]).toString('base64') + ' fabushi-main-node-delivery';
call(['secret', 'set', 'FABUSHI_AI_DEPLOY_SSH_KEY', '--repo', repo, '--env', 'production'], privateKey.export({ type: 'pkcs1', format: 'pem' }));
call(['variable', 'set', 'FABUSHI_AI_DEPLOY_HOST', '--repo', repo, '--env', 'production', '--body', '144.24.17.21']);
call(['variable', 'set', 'FABUSHI_AI_DEPLOY_KNOWN_HOST', '--repo', repo, '--env', 'production', '--body', '144.24.17.21 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICO2zbfpdpVOUOxR2Ktdl7p6sBmBNEz473xLeBQr1h4Z']);
console.log(JSON.stringify({ repository: repo, environment: 'production', secretStored: 'FABUSHI_AI_DEPLOY_SSH_KEY', publicKey: publicSsh }));
