import { CORS_HEADERS } from './config/constants.js';
import { jsonResponse } from './utils/response.js';
import { routePlatformGateway } from './routes/platform-gateway-routes.js';
import { routeCoreRequest } from './routes/core-routes.js';
import { routeAuthRequest } from './routes/auth-routes.js';
import { routeMembershipRequest } from './routes/membership-routes.js';
import { routeMonetizationRequest } from './routes/monetization-routes.js';
import { routeCommerceRequest } from './routes/commerce-routes.js';
import { routeCommunityRequest } from './routes/community-routes.js';
import { routeContentRequest } from './routes/content-routes.js';
import { routeOpsRequest } from './routes/ops-routes.js';
import { routeLegacyPracticeRequest } from './routes/legacy-practice-routes.js';

const ROUTERS = Object.freeze([
  routePlatformGateway,
  routeCoreRequest,
  routeAuthRequest,
  routeMembershipRequest,
  routeMonetizationRequest,
  routeCommerceRequest,
  routeCommunityRequest,
  routeContentRequest,
  routeOpsRequest,
  routeLegacyPracticeRequest,
]);

export async function route(request, env, db, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (pathname === '/health') {
    return jsonResponse({
      status: 'ok',
      role: 'legacy-compatibility-gateway',
      controlPlane: 'mahayana-platform',
      timestamp: new Date().toISOString(),
    });
  }

  const context = { pathname, method, request, env, db, ctx, url };
  for (const domainRouter of ROUTERS) {
    const response = await domainRouter(context);
    if (response) return response;
  }
  return null;
}
