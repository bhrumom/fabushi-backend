import { requireIsolation } from './factory.mjs';

export class CanonicalAuthAdapter {
  constructor({ config, mailbox, fetchImpl = fetch }) {
    this.origin = requireIsolation(config);
    if (!mailbox?.receive) throw new Error('not_configured');
    Object.assign(this, { mailbox, fetchImpl });
  }
  async request(path, body, { form = false, html = false } = {}) {
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
    if (!response.ok) throw new Error('auth_request_failed');
    return html ? null : response.json();
  }
  async register({ username, email, password, deviceIds }) {
    const start = await this.request('/api/auth/browser/start', { deviceId: deviceIds[0], platform: 'desktop' });
    const url = new URL(start.loginUrl);
    const ticket = url.searchParams.get('ticket');
    if (url.origin !== this.origin || url.pathname !== '/api/auth/browser/portal' || url.searchParams.get('attemptId') !== start.attemptId || !/^[a-zA-Z0-9-]{1,80}$/.test(start.attemptId || '') || !ticket || typeof start.pollSecret !== 'string') throw new Error('invalid_auth_attempt');
    const proof = { attemptId: start.attemptId, ticket, email };
    await this.request('/api/auth/browser/register/code', proof, { form: true });
    const code = await this.mailbox.receive({ email, attemptId: start.attemptId });
    if (!/^\d{6}$/.test(code || '')) throw new Error('invalid_mailbox_code');
    await this.request('/api/auth/browser/register', { ...proof, username, verificationCode: code, password, confirmPassword: password }, { form: true, html: true });
    const poll = await this.request(`/api/auth/browser/attempts/${start.attemptId}`, { pollSecret: start.pollSecret });
    if (poll.status !== 'completed') throw new Error('registration_not_completed');
    // Registration HTML can return status 200 for a rejected form. Only the
    // independent authenticated poll proves successful registration.
  }
  async login({ username, password, deviceId }) {
    const session = await this.request('/api/auth/login', { username, password, deviceId });
    if (session.user?.username !== username || session.user?.id == null || typeof session.accessToken !== 'string' || !session.accessToken || typeof session.refreshToken !== 'string' || !session.refreshToken) throw new Error('invalid_account_session');
    return session;
  }
}
