import {
  handleAlipayCheckout,
  handleAlipayWebhook,
  handlePaymentStatus,
  handleStripeCheckout,
  handleStripeWebhook,
} from '../handlers/payment-gateways.js';

export function routePaymentRequest({ pathname, method, request, env }) {
  if (pathname === '/api/pay/status' && method === 'GET') return handlePaymentStatus(request, env);
  if (pathname === '/api/pay/checkout' && method === 'GET') return handleStripeCheckout(request, env);
  if (pathname === '/api/pay/stripe/webhook' && method === 'POST') return handleStripeWebhook(request, env);
  if (pathname === '/api/pay/alipay/checkout' && method === 'GET') return handleAlipayCheckout(request, env);
  if (pathname === '/api/pay/alipay/webhook' && method === 'POST') return handleAlipayWebhook(request, env);
  return null;
}
