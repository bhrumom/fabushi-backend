import {
  handleGetRecords,
  handleUpdateRecord,
  handleDeleteRecord,
  handleGetStats,
  handleGetWeeklyStats,
  handleGetMonthlyStats,
  handleSetGoal,
  handleGetGoals,
  handleMeditationSettings,
  handleGetMeditationGroups,
  handleCreateMeditationGroup,
  handleJoinMeditationGroup,
  handleGetMeditationGroupDetail,
  handleReviewMeditationGroupJoin,
  handleSyncRecord,
} from '../handlers/meditation.js';

export async function routeMeditationRequest({ pathname, method, request, env, db }) {
  if (pathname === '/api/meditation/record' && method === 'POST') {
    return await handleSyncRecord(request, env, db);
  }
  if (pathname === '/api/meditation/records' && method === 'GET') {
    return await handleGetRecords(request, env, db);
  }
  if (pathname === '/api/meditation/records' && method === 'PUT') {
    return await handleUpdateRecord(request, env, db);
  }
  if (pathname === '/api/meditation/records' && method === 'DELETE') {
    return await handleDeleteRecord(request, env, db);
  }
  if (pathname === '/api/meditation/stats' && method === 'GET') {
    return await handleGetStats(request, env, db);
  }
  if (pathname === '/api/meditation/weekly' && method === 'GET') {
    return await handleGetWeeklyStats(request, env, db);
  }
  if (pathname === '/api/meditation/monthly' && method === 'GET') {
    return await handleGetMonthlyStats(request, env, db);
  }
  if (pathname === '/api/meditation/goal' && method === 'POST') {
    return await handleSetGoal(request, env, db);
  }
  if (pathname === '/api/meditation/goal' && method === 'GET') {
    return await handleGetGoals(request, env, db);
  }
  if (pathname === '/api/meditation/settings' && (method === 'GET' || method === 'POST')) {
    return await handleMeditationSettings(request, env, db);
  }
  if (pathname === '/api/meditation/groups' && method === 'GET') {
    return await handleGetMeditationGroups(request, env, db);
  }
  if (pathname === '/api/meditation/groups' && method === 'POST') {
    return await handleCreateMeditationGroup(request, env, db);
  }
  if (pathname === '/api/meditation/groups/join' && method === 'POST') {
    return await handleJoinMeditationGroup(request, env, db);
  }
  if (pathname === '/api/meditation/groups/detail' && method === 'GET') {
    return await handleGetMeditationGroupDetail(request, env, db);
  }
  if (pathname === '/api/meditation/groups/review' && method === 'POST') {
    return await handleReviewMeditationGroupJoin(request, env, db);
  }

  return null;
}
