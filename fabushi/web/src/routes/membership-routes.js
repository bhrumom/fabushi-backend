import { handleUseRedeemCode, handleGetPurchaseHistory, handleGetRedeemHistory } from '../handlers/redeem.js';
import { handleCheckMembershipStatus, handleCheckAlipayMembership } from '../handlers/membership.js';

export async function routeMembershipRequest({ pathname, method, request, env, db }) {
  if (pathname === '/api/alipay/check-membership' && method === 'GET') {
    return await handleCheckAlipayMembership(request, env, db);
  }
  if (pathname === '/api/stripe/membership-status' && method === 'GET') {
    return await handleCheckMembershipStatus(request, env, db);
  }
  if (pathname === '/api/admin/use-redeem-code' && method === 'POST') {
    return await handleUseRedeemCode(request, env, db);
  }
  if (pathname === '/api/admin/purchase-history' && method === 'GET') {
    return await handleGetPurchaseHistory(request, env, db);
  }
  if (pathname === '/api/admin/redeem-history' && method === 'GET') {
    return await handleGetRedeemHistory(request, env, db);
  }

  return null;
}
