// Hosted test resources only; never bind either database to production.
import { CloudJanitor } from './janitor.mjs';

export const remoteTables = [
  'remote_computer_operation_audit','remote_computer_operations',
  'remote_computer_tool_grant_audit','remote_computer_session_tool_grants',
  'remote_computer_audit_events','remote_computer_transport_audit',
  'remote_computer_session_grants','remote_computer_signals',
  'remote_computer_network_binding_audit','remote_computer_network_bindings',
  'remote_computer_network_enrollment_grants',
  'remote_computer_network_ingress_audit','remote_computer_network_ingress_bindings',
  'remote_computer_sessions','remote_computer_clients','remote_computers',
];

export class CloudDeviceJanitor extends CloudJanitor {
  constructor(db, platformDb, journal) { super(db,journal); this.platformDb=platformDb; }
  async platformAll(sql,...values) {
    const r=await this.platformDb.prepare(sql).bind(...values).all();
    if(!r.success)throw Error('janitor_query_failed');
    return r.results;
  }
  allowedTables() {
    return ['account_service_refresh_tokens','account_service_delegations',
      'account_mcp_oauth_attempts','account_mcp_native_credentials',
      'account_connection_grants','account_connections',...super.allowedTables()];
  }
  async capture(input) {
    const refs=await super.capture(input);
    refs.connections ||= [];refs.delegations ||= [];
    const tables=new Set((await this.all("SELECT name FROM sqlite_master WHERE type='table'")).map(x=>x.name));
    if(tables.has('account_connections'))for(const principal of refs.principals) {
      refs.connections.push(...(await this.all('SELECT connection_id FROM account_connections WHERE principal_id=?',principal)).map(x=>x.connection_id));
    }
    if(tables.has('account_service_delegations'))for(const user of refs.users) {
      refs.delegations.push(...(await this.all('SELECT delegation_id FROM account_service_delegations WHERE user_id=?',user)).map(x=>x.delegation_id));
    }
    for(const key of ['connections','delegations'])refs[key]=[...new Set(refs[key])];
    // A persisted indirect ID may never authorize deleting a replacement owner.
    for(const id of refs.connections) {
      const rows=await this.all('SELECT principal_id FROM account_connections WHERE connection_id=?',id);
      if(rows.some(x=>!refs.principals.includes(x.principal_id)))throw Error('janitor_identity_changed');
    }
    for(const id of refs.delegations) {
      const rows=await this.all('SELECT user_id FROM account_service_delegations WHERE delegation_id=?',id);
      if(rows.some(x=>!refs.users.includes(String(x.user_id))))throw Error('janitor_identity_changed');
    }
    this.journal.references(input.leaseId,refs);
    return refs;
  }
  async filters(input) {
    const filters=await super.filters(input),refs=this.journal.references(input.leaseId);
    const tables=await this.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'account_%'");
    for(const {name} of tables) {
      if(!/^[a-z_]+$/.test(name))throw Error('unexpected_schema');
      const columns=(await this.all(`PRAGMA table_info(${name})`)).map(x=>x.name);
      for(const [column,values] of [['connection_id',refs.connections],['delegation_id',refs.delegations]]) {
        if(!values.length||!columns.includes(column))continue;
        const items=filters.get(name)||[];
        items.push({sql:`${column} IN (${values.map(()=>'?').join(',')})`,values});filters.set(name,items);
      }
    }
    return filters;
  }
  async platformPlan(input) {
    const refs=await this.capture(input),users=refs.users;
    const tables=await this.platformAll("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'");
    const names=new Set(tables.map(x=>x.name));
    if(remoteTables.some(name=>!names.has(name)))throw Error('device_schema_not_configured');
    const plan=new Map();
    if(!users.length)return plan;
    const placeholders=users.map(()=>'?').join(',');
    for(const {name} of tables) {
      if(!/^[a-z_]+$/.test(name))throw Error('unexpected_schema');
      const columns=(await this.platformAll(`PRAGMA table_info(${name})`)).map(x=>x.name);
      if(!remoteTables.includes(name)) {
        for(const column of ['user_id','owner_id','owner_user_id'])if(columns.includes(column)) {
          const [row]=await this.platformAll(`SELECT count(*) AS n FROM ${name} WHERE ${column} IN (${placeholders})`,...users);
          if(row.n)throw Error('janitor_scope_blocked');
        }
        if(name.startsWith('remote_computer')) {
          const [row]=await this.platformAll(`SELECT count(*) AS n FROM ${name}`);
          if(row.n)throw Error('janitor_scope_blocked');
        }
        continue;
      }
      if(!columns.includes('user_id'))throw Error('unexpected_schema');
      for(const [column,parent] of [['device_id','remote_computers'],['client_id','remote_computer_clients'],['session_id','remote_computer_sessions']]) {
        if(name===parent||!columns.includes(column))continue;
        const [row]=await this.platformAll(`SELECT count(*) AS n FROM ${name} child JOIN ${parent} parent ON child.${column}=parent.${column} WHERE child.user_id<>parent.user_id AND (child.user_id IN (${placeholders}) OR parent.user_id IN (${placeholders}))`,...users,...users);
        if(row.n)throw Error('janitor_cross_owner_reference');
      }
      plan.set(name,{sql:`user_id IN (${placeholders})`,values:users});
    }
    return plan;
  }
  async remove(input) {
    const auth=await this.filters(input),plan=await this.platformPlan(input);
    await this.assertScope(auth); // All scopes checked before any mutation.
    const refs=this.journal.references(input.leaseId);
    if(refs.users.length) {
      const response=await this.db.prepare(`UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE user_id IN (${refs.users.map(()=>'?').join(',')})`).bind(Math.floor(Date.now()/1000),...refs.users).all();
      if(!response.success)throw Error('janitor_revoke_failed');
    }
    const statements=[];
    for(const table of remoteTables) {
      const filter=plan.get(table);if(filter)statements.push(this.platformDb.prepare(`DELETE FROM ${table} WHERE ${filter.sql}`).bind(...filter.values));
    }
    if(statements.length&&(await this.platformDb.batch(statements)).some(x=>!x.success))throw Error('janitor_delete_failed');
    await super.remove(input);
  }
  async inspect(input) {
    let {remaining}=await super.inspect(input);
    for(const [table,filter] of await this.platformPlan(input)) {
      const [row]=await this.platformAll(`SELECT count(*) AS n FROM ${table} WHERE ${filter.sql}`,...filter.values);remaining+=row.n;
    }
    return {remaining};
  }
}
