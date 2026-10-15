// Synchronous SQLite DO adapter. One fixed DO owns all leases and lifecycle work.
export class DurableJournal {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS maintenance (name TEXT PRIMARY KEY)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, accounts TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS mailbox (email TEXT PRIMARY KEY, code TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS cleanup_refs (lease TEXT PRIMARY KEY, refs TEXT NOT NULL)');
  }
  repaired(){return this.sql.exec("SELECT name FROM maintenance WHERE name='text-user-refs-v1'").toArray().length===1;}
  markRepaired(){this.sql.exec("INSERT OR IGNORE INTO maintenance VALUES('text-user-refs-v1')");}
  cleaned(){return this.sql.exec("SELECT id FROM leases WHERE state='cleaned'").toArray().map(r=>this.get(r.id));}
  reserve(lease, quota) {
    this.storage.transactionSync(() => {
      if (this.get(lease.id)) throw Error('lease_already_allocated');
      if (this.sql.exec("SELECT count(*) AS n FROM leases WHERE state!='cleaned'").one().n >= quota) throw Error('quota_exceeded');
      this.sql.exec('INSERT INTO leases VALUES(?,?,?,?,?)', lease.id, lease.owner, lease.expiresAt, 'allocating', JSON.stringify(lease.accounts));
    });
  }
  get(id) { const row = this.sql.exec('SELECT * FROM leases WHERE id=?', id).toArray()[0]; return row && { id: row.id, owner: row.owner, expiresAt: row.expires, state: row.state, accounts: JSON.parse(row.accounts) }; }
  state(id, state) { this.sql.exec('UPDATE leases SET state=? WHERE id=?', state, id); }
  expired(now) { return this.sql.exec("SELECT id FROM leases WHERE expires<=? AND state!='cleaned'", now).toArray().map(r => r.id); }
  ownsEmail(email, now = Date.now()) {
    return this.sql.exec("SELECT accounts FROM leases WHERE expires>? AND state='allocating'", now).toArray().some(r => JSON.parse(r.accounts).some(a => a.email === email));
  }
  deliver(email, code, now = Date.now()) {
    if (!/^ci_[a-f0-9]{40}_[abc]@ci\.invalid$/.test(email) || !/^\d{6}$/.test(code) || !this.ownsEmail(email, now)) throw Error('mail_denied');
    this.sql.exec('INSERT INTO mailbox VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET code=excluded.code, expires=excluded.expires', email, code, now + 300000);
  }
  consume(email, now = Date.now()) {
    const row = this.sql.exec('SELECT code FROM mailbox WHERE email=? AND expires>?', email, now).toArray()[0];
    this.sql.exec('DELETE FROM mailbox WHERE email=?', email);
    if (!row || !this.ownsEmail(email, now)) throw Error('mail_not_delivered');
    return row.code;
  }
  purgeMail() { this.sql.exec('DELETE FROM mailbox WHERE expires<=?', Date.now()); }
  references(id, refs) {
    if (refs) this.sql.exec('INSERT INTO cleanup_refs VALUES(?,?) ON CONFLICT(lease) DO UPDATE SET refs=excluded.refs', id, JSON.stringify(refs));
    return JSON.parse(this.sql.exec('SELECT refs FROM cleanup_refs WHERE lease=?', id).toArray()[0]?.refs || 'null');
  }
}
