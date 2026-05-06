import { handleRegister, handleLogin, handleGetUserInfo, handleUpdateProfile, handleFirebasePhoneLogin, handleAppleLogin, handleDeleteAccount } from './handlers/auth.js';
import { handleSendSmsCode, handleSmsLogin } from './handlers/sms.js';
import { handleGetComments, handlePostComment, handleDeleteComment, handleGetTaggedPosts, handleGetHotFeed, handleGetPostDetail, handleBatchGetCommentCounts } from './handlers/comments.js';
import { handleSendVerificationCode, handleForgotPassword, handleResetPassword } from './handlers/verification.js';
import { handleGetWechatLoginUrl, handleGetAlipayLoginUrl, handleAlipayLogin, handleAlipayRegister, handleBindEmail, handleMacOSAlipayCallback, handleMobileAlipayCallback, handleGetAlipayAuthString, handleAlipaySDKLogin } from './handlers/thirdparty.js';
import { handleCreateAlipayOrder, handleQueryAlipayOrder, handleAlipayNotify } from './handlers/payment.js';
import { handleVerifyAppleReceipt } from './handlers/apple-iap.js';
import { handleCreateRedeemCode, handleUseRedeemCode, handleGetPurchaseHistory, handleGetRedeemHistory } from './handlers/redeem.js';
import { handleCheckMembershipStatus, handleCheckAlipayMembership } from './handlers/membership.js';
import { handleMigrateKvToD1 } from './handlers/migration.js';
import { handleCheckAdminStatus, handleListRedeemCodes, handleDeleteRedeemCode, handleGetAdminPrice } from './handlers/admin.js';
import { handleGetAssetsList, handleR2List, handleR2Proxy } from './handlers/assets.js';
import { handleSearch, handleGetTextContent, handleGetCategories } from './handlers/search.js';
import { handleGetLeaderboard, handleGetLeaderboardRecords, handleGetPracticeLeaderboard, handleUpdateTransferData } from './handlers/leaderboard.js';
import { handleToggleLike, handleGetLikeCount, handleBatchGetLikeCounts, handleGetMyLikes, handleGetReceivedLikeCount } from './handlers/likes.js';
import { handleToggleFavorite, handleGetMyFavorites, handleBatchCheckFavorites } from './handlers/favorites.js';
import { handleBatchGetContentStats } from './handlers/content-stats.js';
import { handleOnlineJoin, handleOnlineHeartbeat, handleOnlineLeave, handleOnlineCount } from './handlers/online.js';
import { handleSyncRecord, handleGetRecords, handleUpdateRecord, handleDeleteRecord, handleGetStats, handleGetWeeklyStats, handleGetMonthlyStats, handleSetGoal, handleGetGoals, handleMeditationSettings, handleGetMeditationGroups, handleCreateMeditationGroup, handleJoinMeditationGroup, handleGetMeditationGroupDetail, handleReviewMeditationGroupJoin } from './handlers/meditation.js';
import { handleGetSyncData, handlePushSyncData, handleGetSyncState } from './handlers/sync.js';
import { handleToggleFollow, handleGetFollowList, handleGetFollowSummary, handleGetPracticePrivacy, handleUpdatePracticePrivacy } from './handlers/social.js';
import { handleBuiltinMigration, handleFullTextSearch, handleGetCategories as handleBuiltinCategories } from '../migrate-builtin-handler-fixed.js';
import { handleReport, handleBlockUser, handleGetReports, handleReviewReport, handleGetBlocks } from './handlers/moderation.js';
import { handleSubmitFeedback } from './handlers/feedback.js';
import { jsonResponse } from './utils/response.js';

export async function route(request, env, db, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  // 健康检查
  if (pathname === '/health') {
    return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
  }

  // 短信验证码API (全平台支持)
  if (pathname === '/api/sms/send' && method === 'POST') return await handleSendSmsCode(request, env, db);
  if (pathname === '/api/sms/login' && method === 'POST') return await handleSmsLogin(request, env, db);

  // 认证API
  if (pathname === '/api/auth/register' && method === 'POST') return await handleRegister(request, env, db);
  if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(request, env, db);
  if (pathname === '/api/auth/user-info' && method === 'GET') return await handleGetUserInfo(request, env, db);
  if (pathname === '/api/auth/send-verification-code' && method === 'POST') return await handleSendVerificationCode(request, env, ctx);
  if (pathname === '/api/auth/forgot-password' && method === 'POST') return await handleForgotPassword(request, env, db);
  if (pathname === '/api/auth/reset-password' && method === 'POST') return await handleResetPassword(request, env, db);
  if (pathname === '/api/auth/bind-email' && method === 'POST') return await handleBindEmail(request, env, db);
  if (pathname === '/api/auth/bind-email' && method === 'POST') return await handleBindEmail(request, env, db);
  if (pathname === '/api/auth/update-profile' && method === 'POST') return await handleUpdateProfile(request, env, db);
  if (pathname === '/api/auth/firebase-phone-login' && method === 'POST') return await handleFirebasePhoneLogin(request, env, db);
  if (pathname === '/api/auth/apple-login' && method === 'POST') return await handleAppleLogin(request, env, db);
  if (pathname === '/api/auth/delete' && method === 'DELETE') return await handleDeleteAccount(request, env, db);

  // 评论API
  if (pathname === '/api/comments' && method === 'GET') return await handleGetComments(request, env, db);
  if (pathname === '/api/comments' && method === 'POST') return await handlePostComment(request, env, db);
  if (pathname === '/api/comments' && method === 'DELETE') return await handleDeleteComment(request, env, db);
  if (pathname === '/api/comments/batch-counts' && method === 'POST') return await handleBatchGetCommentCounts(request, env, db);

  // 帖子/动态 API（感应/发愿）
  if (pathname === '/api/posts' && method === 'GET') return await handleGetTaggedPosts(request, env, db);
  if (pathname === '/api/posts/detail' && method === 'GET') return await handleGetPostDetail(request, env, db);
  if (pathname === '/api/feed/hot' && method === 'GET') return await handleGetHotFeed(request, env, db);

  // 第三方登录
  if (pathname === '/api/auth/wechat/login-url' && method === 'GET') return await handleGetWechatLoginUrl(request, env);
  if (pathname === '/api/auth/alipay/login-url' && method === 'GET') return await handleGetAlipayLoginUrl(request, env);
  if (pathname === '/api/auth/alipay/login' && method === 'POST') return await handleAlipayLogin(request, env);
  if (pathname === '/api/auth/alipay/register' && method === 'POST') return await handleAlipayRegister(request, env);
  if (pathname === '/api/auth/alipay/macos-callback' && method === 'GET') return await handleMacOSAlipayCallback(request, env);
  if (pathname === '/api/auth/alipay/mobile-callback' && method === 'GET') return await handleMobileAlipayCallback(request, env);
  if (pathname === '/api/auth/alipay/auth-string' && method === 'GET') return await handleGetAlipayAuthString(request, env);
  if (pathname === '/api/auth/alipay/sdk-login' && method === 'POST') return await handleAlipaySDKLogin(request, env);

  // 支付API
  if (pathname === '/api/alipay/create-order' && method === 'POST') return await handleCreateAlipayOrder(request, env, db);
  if (pathname === '/api/alipay/query-order' && method === 'GET') return await handleQueryAlipayOrder(request, env, db);
  if (pathname === '/api/alipay/notify' && method === 'POST') return await handleAlipayNotify(request, env, db);
  if (pathname === '/api/alipay/check-membership' && method === 'GET') return await handleCheckAlipayMembership(request, env, db);
  if (pathname === '/api/apple/verify-receipt' && method === 'POST') return await handleVerifyAppleReceipt(request, env, db);

  // 会员API
  if (pathname === '/api/stripe/membership-status' && method === 'GET') return await handleCheckMembershipStatus(request, env, db);

  // 反馈API
  if (pathname === '/api/feedback' && method === 'POST') return await handleSubmitFeedback(request, env, db);

  // 兑换码API
  if (pathname === '/api/admin/create-redeem-code' && method === 'POST') return await handleCreateRedeemCode(request, env, db);
  if (pathname === '/api/admin/use-redeem-code' && method === 'POST') return await handleUseRedeemCode(request, env, db);
  if (pathname === '/api/admin/purchase-history' && method === 'GET') return await handleGetPurchaseHistory(request, env, db);
  if (pathname === '/api/admin/redeem-history' && method === 'GET') return await handleGetRedeemHistory(request, env, db);
  if (pathname === '/api/admin/redeem-codes' && method === 'GET') return await handleListRedeemCodes(request, env, db);
  if (pathname === '/api/admin/delete-redeem-code' && method === 'DELETE') return await handleDeleteRedeemCode(request, env, db);
  if (pathname === '/api/admin/check-status' && method === 'GET') return await handleCheckAdminStatus(request, env, db);
  if (pathname === '/api/admin/get-price' && method === 'POST') return await handleGetAdminPrice(request, env, db);

  // 资源API
  if (pathname === '/api/assets/list' && method === 'GET') return await handleGetAssetsList(request, env);
  if (pathname === '/r2' && url.searchParams.has('list')) return await handleR2List(request, env);
  if (pathname === '/r2' && url.searchParams.has('file')) return await handleR2Proxy(request, env);

  // 搜索API
  if (pathname === '/api/search' && method === 'GET') return await handleSearch(request, env, db);
  if (pathname === '/api/search/content' && method === 'GET') return await handleGetTextContent(request, env, db);
  if (pathname === '/api/search/categories' && method === 'GET') return await handleGetCategories(request, env, db);

  // 排行榜API
  if (pathname === '/api/leaderboard' && method === 'GET') return await handleGetLeaderboard(request, env, db);
  if (pathname === '/api/leaderboard/practice' && method === 'GET') return await handleGetPracticeLeaderboard(request, env, db);
  if (pathname === '/api/leaderboard/practice/records' && method === 'GET') return await handleGetLeaderboardRecords(request, env, db);
  if (pathname === '/api/leaderboard/records' && method === 'GET') return await handleGetLeaderboardRecords(request, env, db);
  if (pathname === '/api/leaderboard/update' && method === 'POST') return await handleUpdateTransferData(request, env, db);

  // 社交关系与隐私API
  if (pathname === '/api/social/follow/toggle' && method === 'POST') return await handleToggleFollow(request, env, db);
  if (pathname === '/api/social/follows' && method === 'GET') return await handleGetFollowList(request, env, db);
  if (pathname === '/api/social/follow-summary' && method === 'GET') return await handleGetFollowSummary(request, env, db);
  if (pathname === '/api/social/practice-privacy' && method === 'GET') return await handleGetPracticePrivacy(request, env, db);
  if (pathname === '/api/social/practice-privacy' && method === 'POST') return await handleUpdatePracticePrivacy(request, env, db);

  // 点赞API
  if (pathname === '/api/likes/toggle' && method === 'POST') return await handleToggleLike(request, env, db);
  if (pathname === '/api/likes/count' && method === 'GET') return await handleGetLikeCount(request, env, db);
  if (pathname === '/api/likes/batch-counts' && method === 'POST') return await handleBatchGetLikeCounts(request, env, db);
  if (pathname === '/api/likes/my-likes' && method === 'GET') return await handleGetMyLikes(request, env, db);
  if (pathname === '/api/likes/received-count' && method === 'GET') return await handleGetReceivedLikeCount(request, env, db);

  // 收藏API
  if (pathname === '/api/favorites/toggle' && method === 'POST') return await handleToggleFavorite(request, env, db);
  if (pathname === '/api/favorites/my-favorites' && method === 'GET') return await handleGetMyFavorites(request, env, db);
  if (pathname === '/api/favorites/batch-check' && method === 'POST') return await handleBatchCheckFavorites(request, env, db);

  // 内容统计API（合并点赞数+评论数）
  if (pathname === '/api/content/batch-stats' && method === 'POST') return await handleBatchGetContentStats(request, env, db);

  // 在线人数API
  if (pathname === '/api/online/join' && method === 'POST') return await handleOnlineJoin(request, env);
  if (pathname === '/api/online/heartbeat' && method === 'POST') return await handleOnlineHeartbeat(request, env);
  if (pathname === '/api/online/leave' && method === 'POST') return await handleOnlineLeave(request, env);
  if (pathname === '/api/online/count' && method === 'GET') return await handleOnlineCount(request, env);

  // 修行记录API
  if (pathname === '/api/meditation/record' && method === 'POST') return await handleSyncRecord(request, env, db);
  if (pathname === '/api/meditation/records' && method === 'GET') return await handleGetRecords(request, env, db);
  if (pathname === '/api/meditation/records' && method === 'PUT') return await handleUpdateRecord(request, env, db);
  if (pathname === '/api/meditation/records' && method === 'DELETE') return await handleDeleteRecord(request, env, db);
  if (pathname === '/api/meditation/stats' && method === 'GET') return await handleGetStats(request, env, db);
  if (pathname === '/api/meditation/weekly' && method === 'GET') return await handleGetWeeklyStats(request, env, db);
  if (pathname === '/api/meditation/monthly' && method === 'GET') return await handleGetMonthlyStats(request, env, db);
  if (pathname === '/api/meditation/goal' && method === 'POST') return await handleSetGoal(request, env, db);
  if (pathname === '/api/meditation/goal' && method === 'GET') return await handleGetGoals(request, env, db);
  if (pathname === '/api/meditation/settings' && (method === 'GET' || method === 'POST')) return await handleMeditationSettings(request, env, db);
  if (pathname === '/api/meditation/groups' && method === 'GET') return await handleGetMeditationGroups(request, env, db);
  if (pathname === '/api/meditation/groups' && method === 'POST') return await handleCreateMeditationGroup(request, env, db);
  if (pathname === '/api/meditation/groups/join' && method === 'POST') return await handleJoinMeditationGroup(request, env, db);
  if (pathname === '/api/meditation/groups/detail' && method === 'GET') return await handleGetMeditationGroupDetail(request, env, db);
  if (pathname === '/api/meditation/groups/review' && method === 'POST') return await handleReviewMeditationGroupJoin(request, env, db);

  // 同步API（增量同步）
  if (pathname === '/api/sync' && method === 'GET') return await handleGetSyncData(request, env, db);
  if (pathname === '/api/sync' && method === 'POST') return await handlePushSyncData(request, env, db);
  if (pathname === '/api/sync/state' && method === 'GET') return await handleGetSyncState(request, env, db);

  // 迁移API（管理员专用）
  if (pathname === '/api/admin/migrate-kv-to-d1' && method === 'POST') return await handleMigrateKvToD1(request, env, db);

  // 内置内容迁移API
  if (pathname === '/migrate-builtin-complete' && method === 'POST') return await handleBuiltinMigration(request, env);
  if (pathname === '/api/builtin/search' && method === 'GET') return await handleFullTextSearch(request, env);
  if (pathname === '/api/builtin/categories' && method === 'GET') return await handleBuiltinCategories(request, env);

  // 内容举报与屏蔽API
  if (pathname === '/api/report' && method === 'POST') return await handleReport(request, env, db);
  if (pathname === '/api/block-user' && method === 'POST') return await handleBlockUser(request, env, db);
  if (pathname === '/api/admin/reports' && method === 'GET') return await handleGetReports(request, env, db);
  if (pathname === '/api/admin/reports/review' && method === 'POST') return await handleReviewReport(request, env, db);
  if (pathname === '/api/admin/blocks' && method === 'GET') return await handleGetBlocks(request, env, db);

  return null;
}
