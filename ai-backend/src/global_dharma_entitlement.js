export const GLOBAL_DHARMA_PRAYER_WHEEL_CAPABILITY = 'local.prayer-wheel.start';

function denied(reason, extra = {}) {
  return {
    protected: true,
    allowed: false,
    reason,
    effectiveExpiresAt: null,
    purchaseOptions: [],
    ...extra,
  };
}

function publicPurchaseOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((option) => ({
    productId: String(option?.productId ?? ''),
    sku: String(option?.sku ?? ''),
    displayName: String(option?.displayName ?? ''),
    productKind: String(option?.productKind ?? ''),
    subscriptionPeriodSeconds: option?.subscriptionPeriodSeconds ?? null,
    currency: String(option?.currency ?? ''),
    amount: Number(option?.amount ?? 0),
    activeRails: Array.isArray(option?.activeRails) ? option.activeRails.map(String) : [],
  }));
}

export async function readGlobalDharmaEntitlement({
  token,
  capability = GLOBAL_DHARMA_PRAYER_WHEEL_CAPABILITY,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = String(process.env.FABUSHI_API_BASE_URL ?? 'https://api.ombhrum.com').replace(/\/+$/, ''),
} = {}) {
  const credential = String(token ?? '').trim();
  if (!credential) return denied('authentication_required');
  if (typeof fetchImpl !== 'function' || !apiBaseUrl) return denied('entitlement_service_unavailable');
  try {
    const response = await fetchImpl(
      `${apiBaseUrl}/v1/plugins/global-dharma/entitlements/${encodeURIComponent(capability)}`,
      {
        headers: { Accept: 'application/json', Authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      return denied(
        response.status === 401 || response.status === 403
          ? 'authentication_required'
          : `entitlement_http_${response.status}`,
      );
    }
    const payload = await response.json();
    const access = payload?.access && typeof payload.access === 'object' ? payload.access : {};
    return {
      protected: access.protected !== false,
      allowed: access.allowed === true,
      reason: String(access.reason ?? (access.allowed === true ? 'entitled' : 'not_entitled')),
      effectiveExpiresAt: access.effectiveExpiresAt ?? null,
      purchaseOptions: publicPurchaseOptions(payload?.purchaseOptions),
    };
  } catch {
    return denied('entitlement_service_unavailable');
  }
}
