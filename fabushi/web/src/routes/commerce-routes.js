import {
  handleCreateAlipayOrder,
  handleQueryAlipayOrder,
  handleAlipayNotify,
  handleCheckPurchaseEntitlement,
} from '../handlers/payment.js';
import { handleVerifyAppleReceipt } from '../handlers/apple-iap.js';
import { handleCreateRedeemCode } from '../handlers/redeem.js';
import { handleListRedeemCodes, handleDeleteRedeemCode } from '../handlers/admin.js';

export async function routeCommerceRequest({ pathname, method, request, env, db }) {
  if (pathname === '/api/alipay/create-order' && method === 'POST') return handleCreateAlipayOrder(request, env, db);
  if (pathname === '/api/alipay/query-order' && method === 'GET') return handleQueryAlipayOrder(request, env, db);
  if (pathname === '/api/alipay/notify' && method === 'POST') return handleAlipayNotify(request, env, db);
  if (pathname === '/api/purchases/entitlement' && method === 'GET') return handleCheckPurchaseEntitlement(request, env, db);
  if (pathname === '/api/apple/verify-receipt' && method === 'POST') return handleVerifyAppleReceipt(request, env, db);

  if (pathname === '/api/admin/create-redeem-code' && method === 'POST') return handleCreateRedeemCode(request, env, db);
  if (pathname === '/api/admin/redeem-codes' && method === 'GET') return handleListRedeemCodes(request, env, db);
  if (pathname === '/api/admin/delete-redeem-code' && method === 'DELETE') return handleDeleteRedeemCode(request, env, db);
  return null;
}
