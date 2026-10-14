import { createPublicKey, verify } from 'node:crypto';

const issuer = 'https://token.actions.githubusercontent.com';
const jwksUrl = `${issuer}/.well-known/jwks`;
const deny = () => { throw new Error('oidc_denied'); };

export async function verifyActionsIdentity(token, policy, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length > 16384) deny();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) deny();
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch { deny(); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.jku || header.x5u || header.crit) deny();
  const response = await fetchImpl(jwksUrl, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) deny();
  const keys = await response.json();
  const candidates = keys.keys?.filter(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  if (candidates?.length !== 1) deny();
  try {
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: candidates[0], format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) deny();
  } catch { deny(); }
  const seconds = Math.floor(now / 1000);
  if (!policy?.audience || !policy.repository || !policy.repositoryId || !policy.ownerId || !Array.isArray(policy.workflowRefs) || !policy.workflowRefs.length || !Array.isArray(policy.refs) || !policy.refs.length) deny();
  if (claims.iss !== issuer || claims.aud !== policy.audience || claims.repository !== policy.repository ||
      claims.repository_id !== policy.repositoryId || claims.repository_owner_id !== policy.ownerId ||
      !policy.workflowRefs.includes(claims.workflow_ref) || !policy.refs.includes(claims.ref) ||
      claims.sub !== `repo:${policy.repository}:environment:ci-isolated` ||
      !['push', 'workflow_dispatch', 'schedule'].includes(claims.event_name) ||
      !/^[a-f0-9]{40}$/.test(claims.sha || '') ||
      !/^[1-9][0-9]{0,19}$/.test(claims.run_id || '') || !/^[1-9][0-9]{0,5}$/.test(claims.run_attempt || '') ||
      !Number.isInteger(claims.exp) || !Number.isInteger(claims.nbf) || !Number.isInteger(claims.iat) ||
      claims.exp <= seconds || claims.nbf > seconds + 30 || claims.iat > seconds + 30 ||
      claims.exp - claims.iat > 600 || claims.iat < seconds - 600) deny();
  return Object.freeze({ repository: claims.repository, runId: claims.run_id, runAttempt: claims.run_attempt, sourceSha: claims.sha });
}
