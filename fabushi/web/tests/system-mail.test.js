import assert from 'node:assert/strict';
import { sendSystemMail, systemMailConfigured } from '../src/utils/system-mail.js';

const base = {
  AUTH_SYSTEM_MAIL_URL: 'https://mail.test/internal/send',
  AUTH_SYSTEM_MAIL_TOKEN: 't'.repeat(64),
};
assert.equal(systemMailConfigured(base), false);
assert.equal(systemMailConfigured({ ...base, AUTH_SYSTEM_MAIL_ENABLED: 'true' }), true);
assert.equal(systemMailConfigured({ ...base, AUTH_SYSTEM_MAIL_ENABLED: 'TRUE' }), true);
assert.equal(systemMailConfigured({ ...base, AUTH_SYSTEM_MAIL_ENABLED: 'false' }), false);

const env = { ...base, AUTH_SYSTEM_MAIL_ENABLED: 'true' };
const originalFetch = globalThis.fetch;
let captured = null;
globalThis.fetch = async (url, init) => {
  captured = { url: String(url), init };
  return new Response(JSON.stringify({ ok: true, provider: 'bhrum2-postfix' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
const provider = await sendSystemMail({ email: 'user@example.com', subject: 'Subject', text: 'Body' }, env);
assert.equal(provider, 'bhrum2-postfix');
assert.equal(captured.url, env.AUTH_SYSTEM_MAIL_URL);
assert.equal(captured.init.headers.Authorization, `Bearer ${env.AUTH_SYSTEM_MAIL_TOKEN}`);
assert.deepEqual(JSON.parse(captured.init.body), { email: 'user@example.com', subject: 'Subject', text: 'Body' });
globalThis.fetch = originalFetch;

console.log('system-mail.test.js passed');
