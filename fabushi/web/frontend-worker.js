// Flutter Web static frontend Worker.
// API traffic belongs on https://api.ombhrum.com and is intentionally not
// handled here.

const PRIVATE_ASSET_PATTERNS = [
  /^\/(?:src|tests|migrations|dist)\//,
  /^\/(?:agent|docs)\//,
  /^\/\.(?:wranglerignore|last_build_id)$/i,
  /^\/(?:package(?:-lock)?\.json|wrangler(?:-web)?\.toml)$/i,
  /^\/(?:schema(?:[_-].*)?\.sql|migration.*\.sql)$/i,
  /^\/(?:worker|frontend-worker|migrate|retry|deploy|find-and-retry).*\.js$/i,
  /^\/(?:retry|deploy|migrate).*\.(?:sh|bash)$/i,
  /^\/(?:auth-utils|alipay-config|alipay-login-functions|alipay-utils|assets-json)\.js$/i,
  /^\/.*\.md$/i,
];

const FRONTEND_ONLY_API_RESPONSE = {
  success: false,
  error: 'Frontend worker only',
  message: 'Use https://api.ombhrum.com for backend API requests.'
};

function withFrontendHeaders(response, pathname) {
  const headers = new Headers(response.headers);

  if (['/', '/index.html', '/flutter_bootstrap.js', '/flutter_service_worker.js', '/main.dart.js'].includes(pathname)) {
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  } else if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|json|wasm)$/i.test(pathname)) {
    if (!headers.has('Cache-Control')) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (isPrivateAssetPath(pathname)) {
      return new Response('Not Found', {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
        },
      });
    }

    if (pathname.startsWith('/api/') || pathname === '/r2' || pathname === '/health') {
      return new Response(JSON.stringify(FRONTEND_ONLY_API_RESPONSE), {
        status: 404,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    let response = await env.ASSETS.fetch(request);

    if (response.status === 404 && !/\.[^/]+$/.test(pathname)) {
      response = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
    }

    return withFrontendHeaders(response, pathname);
  }
};

function isPrivateAssetPath(pathname) {
  return PRIVATE_ASSET_PATTERNS.some((pattern) => pattern.test(pathname));
}
