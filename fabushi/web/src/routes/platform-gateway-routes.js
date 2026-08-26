const DEFAULT_PLATFORM_ORIGIN = 'https://mahayana-platform.bhrumom.workers.dev';

const EXACT_PLATFORM_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/user-info',
  '/api/auth/logout',
  '/api/auth/oauth/providers',
  '/api/auth/oauth/start',
  '/api/auth/oauth/callback',
]);

function isCanonicalPlatformPath(pathname) {
  if (EXACT_PLATFORM_PATHS.has(pathname)) return true;
  if (pathname.startsWith('/api/auth/browser/')) return true;
  if (pathname.startsWith('/api/auth/oauth/attempts/')) return true;
  return pathname.startsWith('/v1/');
}

function platformOrigin(env) {
  const value = String(env.MAHAYANA_PLATFORM_ORIGIN || DEFAULT_PLATFORM_ORIGIN).trim().replace(/\/$/, '');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('MAHAYANA_PLATFORM_ORIGIN must be a clean HTTPS origin');
  }
  return url.origin;
}

async function fetchPlatform(env, request) {
  // Prefer Cloudflare's internal service binding. If that binding is temporarily
  // unavailable, retry the same request against the canonical HTTPS origin so
  // browser login does not fail closed with a gateway-generated 502.
  if (env.MAHAYANA_PLATFORM && typeof env.MAHAYANA_PLATFORM.fetch === 'function') {
    const directRequest = request.clone();
    try {
      return await env.MAHAYANA_PLATFORM.fetch(request);
    } catch (error) {
      console.warn(
        'Mahayana platform service binding failed; retrying canonical HTTPS origin:',
        error?.message || error,
      );
    }
    return fetch(directRequest, { redirect: 'manual' });
  }
  return fetch(request, { redirect: 'manual' });
}

export async function routePlatformGateway({ pathname, request, env }) {
  if (!isCanonicalPlatformPath(pathname)) return null;

  try {
    const inbound = new URL(request.url);
    const target = new URL(`${pathname}${inbound.search}`, platformOrigin(env));
    // Manual redirect handling is essential for OAuth/browser-first auth: the
    // user's browser, not this gateway Worker, must follow provider redirects.
    const upstreamRequest = new Request(target.toString(), request);
    const upstream = await fetchPlatform(env, upstreamRequest);
    const headers = new Headers(upstream.headers);
    headers.set('X-Fabushi-Control-Plane', 'mahayana-platform');
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    console.error('Mahayana platform gateway failed:', error?.message || error);
    return new Response(JSON.stringify({ error: 'platform_control_plane_unavailable' }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
}
