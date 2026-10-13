const MARKETPLACE_ORIGIN = 'https://ai.ombhrum.com';

// The same existing Node Marketplace owner, not a second registry database.
// Narrow Worker manifest signer runs before this adapter in router composition.
export async function routeExtensionRegistryGateway({ pathname, request }) {
  if (pathname !== '/v1/extensions' && !pathname.startsWith('/v1/extensions/')) return null;
  const incoming = new URL(request.url);
  const target = new URL(pathname + incoming.search, MARKETPLACE_ORIGIN);
  try {
    const response = await fetch(new Request(target, request), { redirect: 'manual' });
    const headers = new Headers(response.headers);
    headers.set('X-Fabushi-Marketplace-Owner', 'existing-node-registry');
    return new Response(response.body, { status: response.status, headers });
  } catch {
    // A write may already have happened. Do not fail over or retry it.
    return new Response(JSON.stringify({ error: 'marketplace_owner_unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}
