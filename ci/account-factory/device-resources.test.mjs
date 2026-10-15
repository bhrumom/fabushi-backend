import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { CloudDeviceJanitor } from './cloud/device-janitor.mjs';
import { remoteMigrations, prepareRemoteSchema } from './cloud/remote-schema.mjs';
import { fileURLToPath } from 'node:url';

// Platform fixtures are byte-for-byte canonical Core f781e6c migration SQL;
// Core c7d0e24 changes authorization only. They are never production schema owners.
function d1(db) {
  return {prepare(sql){let values=[];const q={bind(...args){values=args;return q;},async all(){const s=db.prepare(sql);return {success:true,results:s.columns().length?s.all(...values):(s.run(...values),[])};}};return q;},async batch(items){db.exec('BEGIN');try{const result=[];for(const q of items)result.push(await q.all());db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
}
function fixture() {
  const auth=new DatabaseSync(':memory:'),platform=new DatabaseSync(':memory:');
  const leaseId='a'.repeat(64);
  const accounts=['a','b','c'].map(role=>({role,username:`ci_${leaseId.slice(0,24)}_${role}`,email:`ci_${leaseId.slice(0,40)}_${role}@ci.invalid`,deviceIds:[`ci-${leaseId.slice(0,40)}-${role}-0`]}));
  let refs;
  const journal={get:id=>id===leaseId?{accounts}:null,references(id,value){assert.equal(id,leaseId);if(value)refs=structuredClone(value);return refs&&structuredClone(refs);},sql:{exec(){return{one:()=>({n:0})};}}};
  auth.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT);
    CREATE TABLE account_sessions(session_id TEXT PRIMARY KEY,user_id TEXT,revoked_at INTEGER,expires_at INTEGER);
    CREATE TABLE account_principals(principal_id TEXT PRIMARY KEY,legacy_user_id TEXT);
    CREATE TABLE account_identities(identity_id TEXT PRIMARY KEY,user_id TEXT);
    CREATE TABLE account_connections(connection_id TEXT PRIMARY KEY,principal_id TEXT REFERENCES account_principals(principal_id));
    CREATE TABLE account_connection_grants(connection_id TEXT REFERENCES account_connections(connection_id),capability TEXT);
    CREATE TABLE account_mcp_native_credentials(connection_id TEXT PRIMARY KEY REFERENCES account_connections(connection_id),user_id TEXT);
    CREATE TABLE account_mcp_oauth_attempts(attempt_id TEXT,user_id TEXT,session_id TEXT);
    CREATE TABLE account_service_delegations(delegation_id TEXT PRIMARY KEY,user_id TEXT,parent_session_id TEXT REFERENCES account_sessions(session_id));
    CREATE TABLE account_service_refresh_tokens(token_hash TEXT,delegation_id TEXT REFERENCES account_service_delegations(delegation_id));`);
  auth.prepare('INSERT INTO users VALUES(?,?,?)').run(1,accounts[0].username,accounts[0].email);
  auth.exec(`INSERT INTO users VALUES(2,'other_lease','other@ci.invalid');
    INSERT INTO account_sessions VALUES('s1','1',NULL,9999999999),('s2','2',NULL,9999999999);
    INSERT INTO account_principals VALUES('p1','1'),('p2','2');
    INSERT INTO account_connections VALUES('c1','p1'),('c2','p2');
    INSERT INTO account_connection_grants VALUES('c1','read'),('c2','read');
    INSERT INTO account_mcp_native_credentials VALUES('c1','1'),('c2','2');
    INSERT INTO account_mcp_oauth_attempts VALUES('attempt1','1','s1');
    INSERT INTO account_service_delegations VALUES('delegation1','1','s1'),('delegation2','2','s2');
    INSERT INTO account_service_refresh_tokens VALUES('hash1','delegation1'),('hash2','delegation2');`);
  for(const name of remoteMigrations)platform.exec(readFileSync(new URL('./fixtures/remote-computer/'+name,import.meta.url),'utf8'));
  for(const [id,user] of [['device1','1'],['device2','2']]) {
    platform.prepare("INSERT INTO remote_computers(device_id,user_id,label,device_secret_hash,created_at,last_seen_at) VALUES(?,?,?,'hash',1,1)").run(id,user,'fixture');
    platform.prepare("INSERT INTO remote_computer_clients(client_id,device_id,user_id,label,paired_at,last_seen_at,client_token_hash) VALUES(?,?,?,'client',1,1,'hash')").run('client'+user,id,user);
    platform.prepare("INSERT INTO remote_computer_sessions(session_id,device_id,client_id,user_id,mobile_token_hash,state,created_at,expires_at) VALUES(?,?,?,?,'hash','pending',1,9999999999)").run('remote'+user,id,'client'+user,user);
    platform.prepare("INSERT INTO remote_computer_operations(operation_id,request_id,session_id,user_id,device_id,client_id,tool_name,request_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'read',?,'pending',1,1)").run('op'+user,'req'+user,'remote'+user,user,id,'client'+user,'a'.repeat(64));
  }
  const input={leaseId,accounts};
  return {auth,platform,journal,input,janitor:new CloudDeviceJanitor(d1(auth),d1(platform),journal),d1};
}

test('device janitor removes real-schema children/audits and service credentials, preserving another lease',async()=>{
  const f=fixture();await f.janitor.remove(f.input);
  assert.equal((await f.janitor.inspect(f.input)).remaining,0);
  assert.equal(f.platform.prepare('SELECT user_id FROM remote_computers').get().user_id,'2');
  assert.equal(f.platform.prepare('SELECT user_id FROM remote_computer_operation_audit').get().user_id,'2');
  assert.equal(f.auth.prepare('SELECT token_hash FROM account_service_refresh_tokens').get().token_hash,'hash2');
  assert.equal(f.auth.prepare('SELECT connection_id FROM account_connection_grants').get().connection_id,'c2');
  await f.janitor.remove(f.input);assert.equal((await f.janitor.inspect(f.input)).remaining,0);
});
test('unsupported owned platform data blocks before revocation or deletion',async()=>{
  const f=fixture();f.platform.exec("CREATE TABLE remote_computer_future(user_id TEXT);INSERT INTO remote_computer_future VALUES('1')");
  await assert.rejects(f.janitor.remove(f.input),/scope_blocked/);
  assert.equal(f.auth.prepare("SELECT revoked_at FROM account_sessions WHERE session_id='s1'").get().revoked_at,null);
  assert.equal(f.platform.prepare('SELECT count(*) AS n FROM remote_computers').get().n,2);
});
test('cross-owner child references fail closed without cascading another lease',async()=>{
  const f=fixture();f.platform.exec("UPDATE remote_computer_clients SET device_id='device1' WHERE user_id='2'");
  await assert.rejects(f.janitor.remove(f.input),/cross_owner_reference/);
  assert.equal(f.platform.prepare('SELECT count(*) AS n FROM remote_computers').get().n,2);
});
test('partial platform failure retains references and revocation for safe retry',async()=>{
  const f=fixture();let fail=true;const adapter=d1(f.platform),batch=adapter.batch;
  adapter.batch=async(...args)=>{if(fail){fail=false;throw Error('injected_failure');}return batch(...args);};
  const janitor=new CloudDeviceJanitor(d1(f.auth),adapter,f.journal);
  await assert.rejects(janitor.remove(f.input),/injected_failure/);
  assert.ok(f.auth.prepare("SELECT revoked_at FROM account_sessions WHERE session_id='s1'").get().revoked_at>0);
  assert.equal(f.auth.prepare('SELECT count(*) AS n FROM users').get().n,2);
  await janitor.remove(f.input);assert.equal((await janitor.inspect(f.input)).remaining,0);
});
test('persisted indirect IDs cannot delete replacement principals or reused account IDs',async()=>{
  const f=fixture();await f.janitor.capture(f.input);
  f.auth.exec("UPDATE account_connections SET principal_id='p2' WHERE connection_id='c1'");
  await assert.rejects(f.janitor.remove(f.input),/identity_changed/);
  f.auth.exec("UPDATE account_connections SET principal_id='p1' WHERE connection_id='c1'; UPDATE users SET username='reused' WHERE id=1");
  await assert.rejects(f.janitor.remove(f.input),/identity_changed/);
});
test('cross-lease input is rejected before either database is queried',async()=>{
  const f=fixture();let queries=0;const denied={prepare(){queries++;throw Error('should_not_query');}};
  const janitor=new CloudDeviceJanitor(denied,denied,f.journal);
  await assert.rejects(janitor.remove({...f.input,accounts:[]}),/ownership_denied/);assert.equal(queries,0);
});

function schemaFixture() {
  const db=new DatabaseSync(':memory:');
  const resources=JSON.parse(readFileSync(new URL('./cloud/resources.json',import.meta.url)));
  const schemaRoot=fileURLToPath(new URL('./fixtures/remote-computer/',import.meta.url));
  const query=async(id,sql,params=[])=>{
    assert.equal(id,resources.platformDbId);
    if(/^SELECT/.test(sql))return db.prepare(sql).all(...params);
    if(params.length)db.prepare(sql).run(...params);else db.exec(sql);
    return [];
  };
  return {db,options:{resources,schemaRoot,query}};
}
test('isolated schema applies exact canonical migrations once and rejects digest drift',async()=>{
  const {db,options}=schemaFixture();assert.equal((await prepareRemoteSchema(options)).count,15);
  assert.equal((await prepareRemoteSchema(options)).count,15);
  db.exec("UPDATE ci_fixture_remote_migrations SET digest='changed' WHERE name='0006_remote_computer.sql'");
  await assert.rejects(prepareRemoteSchema(options),/digest_mismatch/);
});
test('unknown schema mutation outcome is retained and never automatically replayed',async()=>{
  const {db,options}=schemaFixture();let fail=true;
  const query=async(...args)=>{const result=await options.query(...args);if(fail&&args[1].includes('CREATE TABLE IF NOT EXISTS remote_computers')){fail=false;throw Error('response_lost');}return result;};
  await assert.rejects(prepareRemoteSchema({...options,query}),/response_lost/);
  assert.equal(db.prepare('SELECT state FROM ci_fixture_remote_migrations').get().state,'applying');
  await assert.rejects(prepareRemoteSchema(options),/requires_recovery/);
});
test('nonempty unowned platform database is never adopted by migration helper',async()=>{
  const {db,options}=schemaFixture();db.exec('CREATE TABLE unrelated(value TEXT)');
  await assert.rejects(prepareRemoteSchema(options),/unowned_platform_database/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='ci_fixture_remote_migrations'").get().n,0);
});
