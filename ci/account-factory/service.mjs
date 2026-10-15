import { verifyActionsIdentity } from './oidc.mjs';

// Mount only on an isolated test deployment. Production gateway never imports
// this module. The host owns its persistent journal and independent TTL timer.
export function fixtureHandler({ factory, policy, oidcOptions, onError }) {
  return async request => {
    const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
    try {
      const authorization = request.headers.get('authorization') || '';
      if (!authorization.startsWith('Bearer ')) return json({ error: 'oidc_denied' }, 401);
      const identity = await verifyActionsIdentity(authorization.slice(7), policy, oidcOptions);
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path === '/v1/leases') {
        const reader = request.body?.getReader();
        const chunks = [];
        let size = 0;
        if (!reader) return json({ error: 'invalid_request' }, 400);
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 512) { await reader.cancel(); return json({ error: 'invalid_request' }, 400); }
          chunks.push(value);
        }
        const raw = new TextDecoder().decode(Buffer.concat(chunks));
        const body = JSON.parse(raw);
        if (Object.keys(body).length !== 1 || typeof body.scenarioId !== 'string') return json({ error: 'invalid_request' }, 400);
        return json(await factory.create(identity, body.scenarioId), 201);
      }
      const match = /^\/v1\/leases\/([a-f0-9]{64})$/.exec(path);
      if (request.method === 'DELETE' && match) return json(await factory.cleanup(identity, match[1]));
      return json({ error: 'route_not_found' }, 404);
    } catch (error) {
      try { onError?.(error); } catch { /* diagnostics must never alter authorization/results */ }
      const code = ['oidc_denied', 'lease_forbidden', 'lease_already_allocated', 'quota_exceeded', 'lease_busy', 'cleanup_failed', 'provision_failed'].includes(error.message) ? error.message : 'fixture_request_failed';
      return json({ error: code }, code === 'oidc_denied' ? 401 : code === 'lease_forbidden' ? 403 : ['lease_already_allocated', 'lease_busy'].includes(code) ? 409 : code === 'quota_exceeded' ? 429 : 503);
    }
  };
}
