export async function resolveDelegatedPluginIdentity({
  token,
  pluginId,
  apiBaseUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  const credential = String(token ?? '').trim();
  const id = String(pluginId ?? '').trim();
  const baseUrl = String(apiBaseUrl ?? '').replace(/\/+$/, '');
  if (!credential || !id || !baseUrl || typeof fetchImpl !== 'function') return null;
  try {
    const response = await fetchImpl(`${baseUrl}/v1/auth/plugin-token/introspect`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pluginId: id }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const userId = String(payload?.user?.id ?? '').trim();
    if (payload?.active !== true || payload?.sessionBound !== true || payload?.pluginId !== id || !userId) {
      return null;
    }
    return { pluginId: id, userId };
  } catch {
    return null;
  }
}
