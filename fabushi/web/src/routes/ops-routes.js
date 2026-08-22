import { handleMigrateKvToD1 } from '../handlers/migration.js';
import { handleCheckAdminStatus, handleGetAdminPrice } from '../handlers/admin.js';
import { handleGetAssetsList, handleR2List, handleR2Proxy } from '../handlers/assets.js';

export async function routeOpsRequest({ pathname, method, request, env, db, url }) {
  if (pathname === '/api/admin/migrate-kv-to-d1' && method === 'POST') {
    return handleMigrateKvToD1(request, env, db);
  }
  if (pathname === '/api/admin/check-status' && method === 'GET') {
    return handleCheckAdminStatus(request, env, db);
  }
  if (pathname === '/api/admin/get-price' && method === 'POST') {
    return handleGetAdminPrice(request, env, db);
  }
  if (pathname === '/api/assets/list' && method === 'GET') return handleGetAssetsList(request, env);
  if (pathname === '/r2' && url.searchParams.has('list')) return handleR2List(request, env);
  if (pathname === '/r2' && url.searchParams.has('file')) return handleR2Proxy(request, env);
  return null;
}
