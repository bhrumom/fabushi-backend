const ORIGIN = 'https://ai.ombhrum.com';
const PATHS = new Set(['/api/fdn/network-enrollment/start', '/api/fdn/network-enrollment/complete']);
const MAX_BODY_BYTES = 64 * 1024;
const OWNER = 'existing-account-api';

function failure(status, error) {
  return new Response(JSON.stringify({ error }), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Fabushi-Fdn-Owner': OWNER,
  } });
}

async function boundedBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

// Routing only: the existing account API and Core grant remain the authority.
export async function routeFdnEnrollmentGateway({ pathname, request, fetchImpl = fetch }) {
  if (!PATHS.has(pathname)) return null;
  const incoming = new URL(request.url);
  if (incoming.pathname !== pathname || incoming.search) return failure(400, 'invalid_enrollment_route');
  if (request.method !== 'POST') return failure(405, 'method_not_allowed');
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return failure(415, 'json_required');
  }
  try {
    const body = await boundedBody(request);
    if (body === null) return failure(413, 'request_too_large');
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const authorization = request.headers.get('authorization');
    if (authorization) headers.set('Authorization', authorization);
    const upstream = await fetchImpl(new Request(ORIGIN + pathname, {
      method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15000),
    }));
    if (upstream.status >= 300 && upstream.status < 400) return failure(502, 'enrollment_owner_unavailable');
    return new Response(upstream.body, { status: upstream.status, headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Fabushi-Fdn-Owner': OWNER,
    } });
  } catch {
    // An enrollment may already exist: never retry/fail over or disclose upstream errors.
    return failure(502, 'enrollment_owner_unavailable');
  }
}
