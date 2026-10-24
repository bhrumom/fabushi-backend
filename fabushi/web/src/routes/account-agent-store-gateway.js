// Existing AccountSyncStore remains the single remote account/file state owner.
const ACCOUNT_STORE_ORIGIN = 'https://ai.ombhrum.com';

function allowedMethods(pathname) {
  if (pathname === '/v1/account/agents' || pathname === '/v1/account/bots' || pathname === '/v1/account/sync') return ['GET'];
  if (/^\/v1\/account\/agents\/[^/]+\/store$/.test(pathname)) return ['GET', 'PUT', 'DELETE'];
  if (/^\/v1\/account\/agents\/[^/]+$/.test(pathname)) return ['GET', 'PUT'];
  if (/^\/v1\/account\/bots\/[^/]+\/add$/.test(pathname)) return ['POST', 'DELETE'];
  return null;
}
function unavailable() {
  return new Response(JSON.stringify({ error: 'account_store_owner_unavailable', outcome: 'unknown', message: 'Reconcile account state before retrying a write.' }), {
    status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function routeAccountAgentStoreGateway({ pathname, request, fetchImpl = fetch }) {
  const methods = allowedMethods(pathname);
  if (!methods) return null;
  if (!methods.includes(request.method)) {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405, headers: { Allow: methods.join(', '), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  const incoming = new URL(request.url);
  const target = new URL(pathname + incoming.search, ACCOUNT_STORE_ORIGIN);
  try {
    const outgoing = new Request(target, request);
    outgoing.headers.delete('host');
    outgoing.headers.delete('x-forwarded-host');
    const upstream = await fetchImpl(outgoing, { redirect: 'manual' });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return unavailable();
    }
    const headers = new Headers(upstream.headers);
    headers.set('X-Fabushi-Agent-Store-Owner', 'existing-node-account-store');
    headers.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch {
    // The canonical owner may already have committed. Never replay through Core
    // or a second origin because this response was lost.
    return unavailable();
  }
}
