import {
  handleAdminAdCampaign,
  handleAdminAdPlacement,
  handleAdminDeveloperCompliance,
  handleAdminPayoutAccount,
  handleAdminReleaseSettlement,
  handleAdminSplitRule,
  handleAdminSubmitPayout,
  handleDeveloperPayoutRequest,
  handleDeveloperRegister,
  handleDeveloperSummary,
  handleMonetizationCheckout,
  handleMonetizationEntitlements,
  handleMonetizationPayment,
  handleMonetizationSubscriptions,
  handleProviderSubscriptionEvent,
  handleTrustedAdEvent,
} from '../handlers/monetization-platform.js';
import { handleAdminMonetizationReconcile } from '../handlers/monetization-reconciliation.js';

export async function routeMonetizationRequest({ pathname, method, request, env, db }) {
  if (pathname === '/api/monetization/checkout' && method === 'POST') return handleMonetizationCheckout(request, env, db);
  if (pathname === '/api/monetization/payment' && method === 'GET') return handleMonetizationPayment(request, env, db);
  if (pathname === '/api/monetization/entitlements' && method === 'GET') return handleMonetizationEntitlements(request, env, db);
  if (pathname === '/api/monetization/subscriptions' && method === 'GET') return handleMonetizationSubscriptions(request, env, db);
  if (pathname === '/api/monetization/developer/register' && method === 'POST') return handleDeveloperRegister(request, env, db);
  if (pathname === '/api/monetization/developer/summary' && method === 'GET') return handleDeveloperSummary(request, env, db);
  if (pathname === '/api/monetization/payouts/request' && method === 'POST') return handleDeveloperPayoutRequest(request, env, db);
  if (pathname === '/api/monetization/providers/subscription-event' && method === 'POST') return handleProviderSubscriptionEvent(request, env);
  if (pathname === '/api/monetization/ads/events' && method === 'POST') return handleTrustedAdEvent(request, env);

  if (pathname === '/api/admin/monetization/split-rules' && method === 'POST') return handleAdminSplitRule(request, env, db);
  if (pathname === '/api/admin/monetization/ad-campaigns' && method === 'POST') return handleAdminAdCampaign(request, env, db);
  if (pathname === '/api/admin/monetization/ad-placements' && method === 'POST') return handleAdminAdPlacement(request, env, db);
  if (pathname === '/api/admin/monetization/developers/compliance' && method === 'POST') return handleAdminDeveloperCompliance(request, env, db);
  if (pathname === '/api/admin/monetization/payout-accounts' && method === 'POST') return handleAdminPayoutAccount(request, env, db);
  if (pathname === '/api/admin/monetization/payouts/submit' && method === 'POST') return handleAdminSubmitPayout(request, env, db);
  if (pathname === '/api/admin/monetization/settlements/release' && method === 'POST') return handleAdminReleaseSettlement(request, env, db);
  if (pathname === '/api/admin/monetization/reconcile' && method === 'POST') return handleAdminMonetizationReconcile(request, env, db);
  return null;
}
