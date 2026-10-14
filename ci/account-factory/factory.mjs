import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';

const knownProduction = new Set(['7b6318f0-fbc2-42f9-9887-85f878ae76d0', '24e53e28-5abd-4850-ae99-cd5d2bdfffb0', '20bc68276a0345ab9b5cbf17c1bd51c5', '94534f35a0a34023a428a065f77f1911', '773e778850ea429d99686ff4fbbe1180', '59c5263942b4436191e6dffbaacc5957']);
export function requireIsolation(config) {
  if (config?.environment !== 'ci-isolated' || !Array.isArray(config.productionResourceIds) || !config.productionResourceIds.length) throw new Error('not_configured');
  const url = new URL(config.authOrigin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      url.origin !== config.allowedAuthOrigin || url.hostname === 'ombhrum.com' || url.hostname.endsWith('.ombhrum.com') ||
      ['mahayana-platform.bhrumom.workers.dev', 'fabushi-flutter-web-prod.bhrumom.workers.dev'].includes(url.hostname)) throw new Error('unsafe_test_origin');
  const ids = [config.accountDbId, config.platformDbId, config.mailboxResourceId];
  const production = new Set([...knownProduction, ...config.productionResourceIds]);
  if (ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(id) || production.has(id)) || new Set(ids).size !== ids.length) throw new Error('unsafe_test_resources');
  return url.origin;
}
function ownerKey(identity) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity?.repository || '') || !/^[1-9][0-9]{0,19}$/.test(identity.runId || '') || !/^[1-9][0-9]{0,5}$/.test(identity.runAttempt || '') || !/^[a-f0-9]{40}$/.test(identity.sourceSha || '')) throw new Error('invalid_identity');
  return `${identity.repository}:${identity.runId}:${identity.runAttempt}:${identity.sourceSha}`;
}
export class LeaseJournal {
  constructor(path) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, accounts TEXT NOT NULL);');
  }
  reserve(lease, quota) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.get(lease.id)) throw new Error('lease_already_allocated');
      if (this.db.prepare("SELECT count(*) AS n FROM leases WHERE state != 'cleaned'").get().n >= quota) throw new Error('quota_exceeded');
      this.db.prepare('INSERT INTO leases VALUES (?, ?, ?, ?, ?)').run(lease.id, lease.owner, lease.expiresAt, 'allocating', JSON.stringify(lease.accounts));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM leases WHERE id=?').get(id);
    return row && { id: row.id, owner: row.owner, expiresAt: row.expires, state: row.state, accounts: JSON.parse(row.accounts) };
  }
  state(id, state) { this.db.prepare('UPDATE leases SET state=? WHERE id=?').run(state, id); }
  expired(now) { return this.db.prepare("SELECT id FROM leases WHERE expires<=? AND state!='cleaned'").all(now).map(r => r.id); }
  close() { this.db.close(); }
}
export class AccountFactory {
  constructor({ config, journal, auth, janitor, now = Date.now, quota = 20, ttlMs = 900000 }) {
    requireIsolation(config);
    if (!auth?.register || !auth?.login || !janitor?.remove || !janitor?.inspect) throw new Error('not_configured');
    if (!Number.isInteger(quota) || quota < 1 || quota > 100 || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw new Error('invalid_limits');
    Object.assign(this, { config, journal, auth, janitor, now, quota, ttlMs });
    this.busy = new Set();
  }
  async create(identity, scenario) {
    const owner = ownerKey(identity);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(scenario || '')) throw new Error('invalid_scenario');
    const id = createHash('sha256').update(`${owner}:${scenario}`).digest('hex');
    const lease = { id, owner, expiresAt: this.now() + this.ttlMs, accounts: ['a', 'b', 'c'].map(role => ({
      role, username: `ci_${id.slice(0, 24)}_${role}`, email: `ci_${id.slice(0, 40)}_${role}@ci.invalid`,
      deviceIds: [0, ...(role === 'a' ? [1] : [])].map(n => `ci-${id.slice(0, 40)}-${role}-${n}`),
    })) };
    this.journal.reserve(lease, this.quota);
    this.busy.add(id);
    const credentials = [];
    try {
      for (const account of lease.accounts) {
        if (this.now() >= lease.expiresAt) throw new Error('lease_expired');
        const password = randomBytes(32).toString('base64url');
        await this.auth.register({ ...account, password });
        const sessions = [];
        for (const deviceId of account.deviceIds) sessions.push(await this.auth.login({ username: account.username, password, deviceId }));
        credentials.push({ ...account, password, sessions });
      }
      if (this.now() >= lease.expiresAt) throw new Error('lease_expired');
      this.journal.state(id, 'active');
      return { leaseId: id, expiresAt: lease.expiresAt, accounts: credentials };
    } catch {
      // Retain all planned identities, including an account whose create response
      // was lost. Cleanup never depends on receiving the create response.
      this.busy.delete(id);
      try { await this.clean(id); } catch { /* durable cleanup_failed; sweeper retries */ }
      throw new Error('provision_failed');
    } finally { this.busy.delete(id); }
  }
  async cleanup(identity, id) {
    const lease = this.journal.get(id);
    if (!lease || lease.owner !== ownerKey(identity)) throw new Error('lease_forbidden');
    return this.clean(id);
  }
  async clean(id) {
    if (this.busy.has(id)) throw new Error('lease_busy');
    const lease = this.journal.get(id);
    if (!lease) throw new Error('lease_missing');
    if (lease.state === 'cleaned') return { leaseId: id, remaining: 0 };
    this.busy.add(id);
    try {
      await this.janitor.remove({ leaseId: id, accounts: lease.accounts });
      const result = await this.janitor.inspect({ leaseId: id, accounts: lease.accounts });
      if (result?.remaining !== 0) throw new Error('cleanup_residuals');
      this.journal.state(id, 'cleaned');
      return { leaseId: id, remaining: 0 };
    } catch { this.journal.state(id, 'cleanup_failed'); throw new Error('cleanup_failed'); }
    finally { this.busy.delete(id); }
  }
  async sweep() {
    const results = [];
    for (const id of this.journal.expired(this.now())) {
      try { results.push(await this.clean(id)); } catch { results.push({ leaseId: id, status: 'blocked' }); }
    }
    return results;
  }
}
