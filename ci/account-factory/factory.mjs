import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
export { requireIsolation, AccountFactory } from './factory-core.mjs';

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
