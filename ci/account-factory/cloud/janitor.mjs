// Auth-only janitor. Never grant this Worker production database bindings.
export class CloudJanitor {
  constructor(db, journal) { this.db = db; this.journal = journal; }
  async all(sql, ...values) {
    const r = await this.db.prepare(sql).bind(...values).all();
    if (!r.success) throw Error('janitor_query_failed');
    return r.results;
  }
  validate({ leaseId, accounts }) {
    const lease = this.journal.get(leaseId);
    if (!lease || JSON.stringify(lease.accounts) !== JSON.stringify(accounts)) throw Error('janitor_ownership_denied');
    for (const a of accounts) {
      if (a.username !== `ci_${leaseId.slice(0,24)}_${a.role}` || a.email !== `ci_${leaseId.slice(0,40)}_${a.role}@ci.invalid` || !['a','b','c'].includes(a.role)) throw Error('janitor_ownership_denied');
    }
  }
  async capture(input) {
    this.validate(input);
    const previous = this.journal.references(input.leaseId) || { users: [], sessions: [], principals: [], identities: [] };
    for (const a of input.accounts) {
      const users = await this.all('SELECT id, username, email FROM users WHERE username=? OR email=?', a.username, a.email);
      if (users.some(u => u.username !== a.username || u.email !== a.email)) throw Error('janitor_identity_changed');
      for (const { id } of users) {
        previous.users.push(id);
        previous.sessions.push(...(await this.all('SELECT session_id FROM account_sessions WHERE user_id=?', id)).map(r=>r.session_id));
        previous.principals.push(...(await this.all('SELECT principal_id FROM account_principals WHERE legacy_user_id=?', id)).map(r=>r.principal_id));
        previous.identities.push(...(await this.all('SELECT identity_id FROM account_identities WHERE user_id=?', id)).map(r=>r.identity_id));
      }
    }
    for (const k of Object.keys(previous)) previous[k] = [...new Set(previous[k])];
    this.journal.references(input.leaseId, previous);
    return previous;
  }
  async filters(input) {
    const refs = await this.capture(input);
    const filters = new Map();
    const add = (table, column, values) => { if (!values.length) return; const items=filters.get(table)||[]; items.push({ sql: `${column} IN (${values.map(()=>'?').join(',')})`, values }); filters.set(table,items); };
    // This schema-derived inspection detects auth residue even after parent rows
    // were removed by a partial cleanup. Persisted captured IDs survive retries.
    const tables = await this.all("SELECT name FROM sqlite_master WHERE type='table' AND (name='users' OR name='email_username_mapping' OR name LIKE 'account_%')");
    for (const { name } of tables) {
      if (!/^[a-z_]+$/.test(name)) throw Error('unexpected_schema');
      const columns = (await this.all(`PRAGMA table_info(${name})`)).map(r=>r.name);
      for (const column of columns) {
        if (['user_id','legacy_user_id','account_user_id'].includes(column) || (name==='users' && column==='id')) add(name,column,refs.users);
        if (column==='session_id' || column==='parent_session_id') add(name,column,refs.sessions);
        if (column==='principal_id') add(name,column,refs.principals);
        if (column==='identity_id') add(name,column,refs.identities);
        if (column==='username') add(name,column,input.accounts.map(a=>a.username));
        if (column==='email') add(name,column,input.accounts.map(a=>a.email));
        if (column==='device_id') add(name,column,input.accounts.flatMap(a=>a.deviceIds));
      }
    }
    return filters;
  }
  async remove(input) {
    const filters = await this.filters(input);
    const allowed = ['account_refresh_tokens','account_auth_events','account_sessions','account_password_credentials','account_contact_points','account_identity_principals','account_principals','account_identities','email_username_mapping','account_email_challenges','account_oauth_attempts','users'];
    // Do not silently cascade-delete resources beyond the accepted auth scope.
    for (const [table, items] of filters) if (!allowed.includes(table)) {
      const [row] = await this.all(`SELECT count(*) AS n FROM ${table} WHERE ${items.map(x=>x.sql).join(' OR ')}`, ...items.flatMap(x=>x.values));
      if (row.n) throw Error('janitor_scope_blocked');
    }
    const statements=[];
    for (const table of allowed) {
      const items=filters.get(table); if (!items?.length) continue;
      statements.push(this.db.prepare(`DELETE FROM ${table} WHERE ${items.map(x=>x.sql).join(' OR ')}`).bind(...items.flatMap(x=>x.values)));
    }
    const result=await this.db.batch(statements);
    if (result.some(r=>!r.success)) throw Error('janitor_delete_failed');
    for(const a of input.accounts) this.journal.sql.exec('DELETE FROM mailbox WHERE email=?',a.email);
  }
  async inspect(input) {
    let remaining=0;
    for (const [table,items] of await this.filters(input)) {
      const [row]=await this.all(`SELECT count(*) AS n FROM ${table} WHERE ${items.map(x=>x.sql).join(' OR ')}`,...items.flatMap(x=>x.values));
      remaining+=row.n;
    }
    for(const a of input.accounts) remaining+=this.journal.sql.exec('SELECT count(*) AS n FROM mailbox WHERE email=?',a.email).one().n;
    return {remaining};
  }
}
