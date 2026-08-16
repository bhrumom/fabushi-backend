export function systemMailConfigured(env) {
  const enabled = String(env.AUTH_SYSTEM_MAIL_ENABLED || '').toLowerCase() === 'true';
  const url = String(env.AUTH_SYSTEM_MAIL_URL || '').trim();
  const token = String(env.AUTH_SYSTEM_MAIL_TOKEN || '');
  return enabled && url.startsWith('https://') && token.length >= 32;
}

export async function sendSystemMail({ email, subject, text }, env) {
  if (!systemMailConfigured(env)) {
    throw new Error('system_mail_unavailable');
  }

  const response = await fetch(String(env.AUTH_SYSTEM_MAIL_URL).trim(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.AUTH_SYSTEM_MAIL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, subject, text }),
  });

  if (!response.ok) {
    response.body?.cancel?.();
    throw new Error('system_mail_delivery_failed');
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('system_mail_delivery_failed');
  }
  if (result?.ok !== true) {
    throw new Error('system_mail_delivery_failed');
  }
  return result.provider || 'bhrum2-mail';
}
