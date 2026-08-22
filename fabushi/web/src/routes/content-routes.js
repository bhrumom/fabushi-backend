import { handleSearch, handleGetTextContent, handleGetCategories } from '../handlers/search.js';
import { handleGetCbetaSendTexts, handleProxyCbetaRequest } from '../handlers/cbeta.js';
import { handleGetSyncData, handlePushSyncData, handleGetSyncState } from '../handlers/sync.js';
import {
  handleBuiltinMigration,
  handleFullTextSearch,
  handleGetCategories as handleBuiltinCategories,
} from '../../migrate-builtin-handler-fixed.js';

export async function routeContentRequest({ pathname, method, request, env, db }) {
  if (pathname === '/api/search' && method === 'GET') return handleSearch(request, env, db);
  if (pathname === '/api/search/content' && method === 'GET') return handleGetTextContent(request, env, db);
  if (pathname === '/api/search/categories' && method === 'GET') return handleGetCategories(request, env, db);
  if (pathname === '/api/cbeta/send-texts' && method === 'GET') return handleGetCbetaSendTexts(request, env);
  if (pathname.startsWith('/api/cbeta/') && (method === 'GET' || method === 'HEAD')) {
    return handleProxyCbetaRequest(request, env);
  }
  if (pathname === '/api/sync' && method === 'GET') return handleGetSyncData(request, env, db);
  if (pathname === '/api/sync' && method === 'POST') return handlePushSyncData(request, env, db);
  if (pathname === '/api/sync/state' && method === 'GET') return handleGetSyncState(request, env, db);
  if (pathname === '/migrate-builtin-complete' && method === 'POST') return handleBuiltinMigration(request, env);
  if (pathname === '/api/builtin/search' && method === 'GET') return handleFullTextSearch(request, env);
  if (pathname === '/api/builtin/categories' && method === 'GET') return handleBuiltinCategories(request, env);
  return null;
}
