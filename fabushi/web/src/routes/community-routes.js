import {
  handleGetComments,
  handlePostComment,
  handleDeleteComment,
  handleGetTaggedPosts,
  handleGetHotFeed,
  handleGetPostDetail,
  handleBatchGetCommentCounts,
} from '../handlers/comments.js';
import { handleSubmitFeedback } from '../handlers/feedback.js';
import {
  handleToggleFollow,
  handleGetFollowList,
  handleGetFollowSummary,
  handleGetPracticePrivacy,
  handleUpdatePracticePrivacy,
} from '../handlers/social.js';
import {
  handleAcceptFriendRequest,
  handleCreateFriendRequest,
  handleListDirectMessages,
  handleListFriends,
  handleListIncomingFriendRequests,
  handleSearchFriendUsers,
  handleSendDirectMessage,
} from '../handlers/friends.js';
import {
  handleToggleLike,
  handleGetLikeCount,
  handleBatchGetLikeCounts,
  handleGetMyLikes,
  handleGetReceivedLikeCount,
} from '../handlers/likes.js';
import { handleToggleFavorite, handleGetMyFavorites, handleBatchCheckFavorites } from '../handlers/favorites.js';
import { handleBatchGetContentStats } from '../handlers/content-stats.js';
import { handleOnlineJoin, handleOnlineHeartbeat, handleOnlineLeave, handleOnlineCount } from '../handlers/online.js';
import { handleReport, handleBlockUser, handleGetReports, handleReviewReport, handleGetBlocks } from '../handlers/moderation.js';

export async function routeCommunityRequest({ pathname, method, request, env, db }) {
  if (pathname === '/api/comments' && method === 'GET') return handleGetComments(request, env, db);
  if (pathname === '/api/comments' && method === 'POST') return handlePostComment(request, env, db);
  if (pathname === '/api/comments' && method === 'DELETE') return handleDeleteComment(request, env, db);
  if (pathname === '/api/comments/batch-counts' && method === 'POST') return handleBatchGetCommentCounts(request, env, db);
  if (pathname === '/api/posts' && method === 'GET') return handleGetTaggedPosts(request, env, db);
  if (pathname === '/api/posts/detail' && method === 'GET') return handleGetPostDetail(request, env, db);
  if (pathname === '/api/feed/hot' && method === 'GET') return handleGetHotFeed(request, env, db);
  if (pathname === '/api/feedback' && method === 'POST') return handleSubmitFeedback(request, env, db);

  if (pathname === '/api/social/follow/toggle' && method === 'POST') return handleToggleFollow(request, env, db);
  if (pathname === '/api/social/follows' && method === 'GET') return handleGetFollowList(request, env, db);
  if (pathname === '/api/social/follow-summary' && method === 'GET') return handleGetFollowSummary(request, env, db);
  if (pathname === '/api/social/practice-privacy' && method === 'GET') return handleGetPracticePrivacy(request, env, db);
  if (pathname === '/api/social/practice-privacy' && method === 'POST') return handleUpdatePracticePrivacy(request, env, db);
  if (pathname === '/api/social/users/search' && method === 'GET') return handleSearchFriendUsers(request, env, db);
  if (pathname === '/api/social/friends' && method === 'GET') return handleListFriends(request, env, db);
  if (pathname === '/api/social/friend-requests' && method === 'POST') return handleCreateFriendRequest(request, env, db);
  if (pathname === '/api/social/friend-requests/incoming' && method === 'GET') return handleListIncomingFriendRequests(request, env, db);
  const friendAcceptMatch = pathname.match(/^\/api\/social\/friend-requests\/(\d+)\/accept$/);
  if (friendAcceptMatch && method === 'POST') return handleAcceptFriendRequest(request, env, db, friendAcceptMatch[1]);
  if (pathname === '/api/social/messages' && method === 'GET') return handleListDirectMessages(request, env, db);
  if (pathname === '/api/social/messages' && method === 'POST') return handleSendDirectMessage(request, env, db);

  if (pathname === '/api/likes/toggle' && method === 'POST') return handleToggleLike(request, env, db);
  if (pathname === '/api/likes/count' && method === 'GET') return handleGetLikeCount(request, env, db);
  if (pathname === '/api/likes/batch-counts' && method === 'POST') return handleBatchGetLikeCounts(request, env, db);
  if (pathname === '/api/likes/my-likes' && method === 'GET') return handleGetMyLikes(request, env, db);
  if (pathname === '/api/likes/received-count' && method === 'GET') return handleGetReceivedLikeCount(request, env, db);
  if (pathname === '/api/favorites/toggle' && method === 'POST') return handleToggleFavorite(request, env, db);
  if (pathname === '/api/favorites/my-favorites' && method === 'GET') return handleGetMyFavorites(request, env, db);
  if (pathname === '/api/favorites/batch-check' && method === 'POST') return handleBatchCheckFavorites(request, env, db);
  if (pathname === '/api/content/batch-stats' && method === 'POST') return handleBatchGetContentStats(request, env, db);

  if (pathname === '/api/online/join' && method === 'POST') return handleOnlineJoin(request, env);
  if (pathname === '/api/online/heartbeat' && method === 'POST') return handleOnlineHeartbeat(request, env);
  if (pathname === '/api/online/leave' && method === 'POST') return handleOnlineLeave(request, env);
  if (pathname === '/api/online/count' && method === 'GET') return handleOnlineCount(request, env);
  if (pathname === '/api/report' && method === 'POST') return handleReport(request, env, db);
  if (pathname === '/api/block-user' && method === 'POST') return handleBlockUser(request, env, db);
  if (pathname === '/api/admin/reports' && method === 'GET') return handleGetReports(request, env, db);
  if (pathname === '/api/admin/reports/review' && method === 'POST') return handleReviewReport(request, env, db);
  if (pathname === '/api/admin/blocks' && method === 'GET') return handleGetBlocks(request, env, db);
  return null;
}
