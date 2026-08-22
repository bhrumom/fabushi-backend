import { handleDachengAiProxy, isDachengAiPath } from '../handlers/dacheng-ai.js';
import {
  handleAppVersionPolicy,
  handleAdminUpsertAppVersionPolicy,
  handleAutomationSyncAppVersionPolicy,
} from '../handlers/app-version.js';
import { handleOfficialSiteReleaseCollection } from '../handlers/official-site-release.js';

// Platform domains such as auth, workspaces, AI usage, marketplace, wallet and
// remote computer are owned by the Mahayana Rust control plane and are routed
// before this legacy/core adapter.
export async function routeCoreRequest({ pathname, method, request, env, db }) {
  if (isDachengAiPath(pathname)) return handleDachengAiProxy(request, env);
  if (pathname === '/api/app/version-policy' && method === 'GET') {
    return handleAppVersionPolicy(request, env, db);
  }
  if (pathname === '/api/admin/app-version-policy' && method === 'POST') {
    return handleAdminUpsertAppVersionPolicy(request, env, db);
  }
  if (pathname === '/api/internal/app-version-policy/sync' && method === 'POST') {
    return handleAutomationSyncAppVersionPolicy(request, env, db);
  }
  if (pathname === '/api/site/releases' && method === 'GET') {
    return handleOfficialSiteReleaseCollection(request, env, db);
  }
  return null;
}
