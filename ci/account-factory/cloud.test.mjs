import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DurableJournal } from './cloud/journal.mjs';
import { CloudJanitor } from './cloud/janitor.mjs';
import { AccountFactory } from './factory-core.mjs';
import { readFileSync } from 'node:fs';

function storage() {
  const db=new DatabaseSync(':memory:');
  return { sql:{exec(sql,...args){const s=db.prepare(sql);let rows=[];if(s.columns().length) rows=s.all(...args);else s.run(...args);return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}};}},transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},db};
}
const id='a'.repeat(64);
const accounts=['a','b','c'].map(role=>({role,username:`ci_${id.slice(0,24)}_${role}`,email:`ci_${id.slice(0,40)}_${role}@ci.invalid`,deviceIds:[`ci-${id.slice(0,40)}-${role}-0`]}));
function lease(j,expiresAt=Date.now()+60000){j.reserve({id,owner:'repo:run',expiresAt,accounts},2);}

test('DO journal reserves atomically, refuses replay, enforces quota and persists restart',()=>{
 const s=storage(),j=new DurableJournal(s);lease(j);
 assert.throws(()=>lease(j),/already/);
 j.reserve({id:'b'.repeat(64),owner:'other',expiresAt:1,accounts:[]},2);
 assert.throws(()=>j.reserve({id:'c'.repeat(64),owner:'third',expiresAt:2,accounts:[]},2),/quota/);
 const restarted=new DurableJournal(s);assert.equal(restarted.get(id).state,'allocating');assert.deepEqual(restarted.expired(10),['b'.repeat(64)]);
});
test('mailbox requires reserved identity, validates code, expires and consumes once',()=>{
 const j=new DurableJournal(storage());lease(j);
 assert.throws(()=>j.deliver('outsider@ci.invalid','123456'),/denied/);
 assert.throws(()=>j.deliver(accounts[0].email,'bad'),/denied/);
 j.deliver(accounts[0].email,'123456');assert.equal(j.consume(accounts[0].email),'123456');assert.throws(()=>j.consume(accounts[0].email),/not_delivered/);
 j.deliver(accounts[0].email,'654321');assert.throws(()=>j.consume(accounts[0].email,Date.now()+400000),/not_delivered/);
 j.state(id,'active');assert.throws(()=>j.deliver(accounts[0].email,'123456'),/denied/);
});
test('janitor rejects cross-lease input before issuing any SQL',async()=>{
 const j=new DurableJournal(storage());lease(j);let calls=0;
 const janitor=new CloudJanitor({prepare(){calls++;throw Error('unexpected');}},j);
 await assert.rejects(janitor.remove({leaseId:id,accounts:[{...accounts[0],email:'other@ci.invalid'}]}),/ownership/);assert.equal(calls,0);
});
function d1(db){return {prepare(sql){let values=[];const q={bind(...args){values=args;return q;},async all(){const stmt=db.prepare(sql);return{success:true,results:stmt.columns().length?stmt.all(...values):(stmt.run(...values),[])};}};return q;},async batch(items){db.exec('BEGIN');try{const r=[];for(const q of items)r.push(await q.all());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};}
function janitorFixture(){
 const j=new DurableJournal(storage());lease(j);const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT); CREATE TABLE account_sessions(session_id TEXT PRIMARY KEY,user_id INTEGER); CREATE TABLE account_identities(identity_id TEXT PRIMARY KEY,user_id TEXT); CREATE TABLE account_principals(principal_id TEXT PRIMARY KEY,legacy_user_id INTEGER); CREATE TABLE account_refresh_tokens(token TEXT,session_id TEXT REFERENCES account_sessions(session_id)); CREATE TABLE account_email_challenges(email TEXT); CREATE TABLE account_oauth_attempts(device_id TEXT);');
 db.prepare('INSERT INTO users VALUES(?,?,?)').run(1,accounts[0].username,accounts[0].email);db.exec("INSERT INTO users VALUES(2,'unrelated','unrelated@ci.invalid'); INSERT INTO account_sessions VALUES('s1',1),('s2',2); INSERT INTO account_refresh_tokens VALUES('r1','s1'),('r2','s2'); INSERT INTO account_principals VALUES('p1',1); INSERT INTO account_identities VALUES('i1','1');");
 return {j,db,janitor:new CloudJanitor(d1(db),j),input:{leaseId:id,accounts}};
}
test('janitor deletes owned auth children and proves zero while preserving another lease',async()=>{
 const {db,janitor,input}=janitorFixture();await janitor.remove(input);assert.deepEqual(await janitor.inspect(input),{remaining:0});assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n,1);assert.equal(db.prepare('SELECT token FROM account_refresh_tokens').get().token,'r2');await janitor.remove(input);assert.deepEqual(await janitor.inspect(input),{remaining:0});
});
test('janitor persists IDs so partial deletion cannot hide orphan session data',async()=>{
 const {db,janitor,input}=janitorFixture();await janitor.capture(input);db.exec('DELETE FROM users WHERE id=1');assert.ok((await janitor.inspect(input)).remaining>0);await janitor.remove(input);assert.equal((await janitor.inspect(input)).remaining,0);
});
test('janitor fails closed when account owns resources outside accepted auth scope',async()=>{
 const {db,janitor,input}=janitorFixture();db.exec("CREATE TABLE account_connections(connection_id TEXT,principal_id TEXT);INSERT INTO account_connections VALUES('c1','p1')");await assert.rejects(janitor.remove(input),/scope_blocked/);assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n,2);
});
test('cloud resources remain independent and runtime-independent factory is reusable',()=>{
 const r=JSON.parse(readFileSync(new URL('./cloud/resources.json',import.meta.url)));assert.equal(r.environment,'ci-isolated');assert.notEqual(r.accountDbId,r.platformDbId);assert.ok(!r.productionResourceIds.includes(r.accountDbId));assert.ok(!r.productionResourceIds.includes(r.platformDbId));assert.equal(typeof AccountFactory,'function');
});

test('janitor fails closed on changed email instead of claiming clean',async()=>{
 const {db,janitor,input}=janitorFixture();await janitor.capture(input);db.exec("UPDATE users SET email='changed@ci.invalid' WHERE id=1");await assert.rejects(janitor.remove(input),/identity_changed/);assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n,2);
});

import {failureCategory,observedAuthFetch,safeFailureDetail} from './cloud/diagnostics.mjs';
test('failure diagnostics never expose upstream bodies, credentials, codes or error text',async()=>{
 const secret='PRIVATE_PASSWORD_123456';let output;
 const fn=observedAuthFetch(value=>{output=value;},async()=>new Response(`Error 1102 ${secret}`,{status:500}));
 await fn('https://test.invalid/api/auth/browser/register',{});
 assert.deepEqual(output,{route:'/api/auth/browser/register',status:500,category:'worker_resource_limit'});
 assert.ok(!JSON.stringify(output).includes(secret));assert.equal(failureCategory(Error(secret)),'unclassified_failure');
 assert.equal(failureCategory(Error(`FOREIGN KEY constraint failed: ${secret}`)),'foreign_key_constraint');
 const failing=observedAuthFetch(value=>{output=value;},async()=>{throw Error(secret);});
 await assert.rejects(failing('https://test.invalid/api/auth/browser/attempts/private-id',{}),/auth_transport_failed/);
 assert.deepEqual(output,{route:'/api/auth/browser/attempts/:id',status:'transport_failed',category:'unclassified_failure'});
});

import {fixtureHandler} from './service.mjs';
test('diagnostic observer failure cannot change invalid-OIDC denial or disclose errors',async()=>{
 const handler=fixtureHandler({factory:{},policy:{},onError(){throw Error('PRIVATE_OBSERVER_FAILURE');}});
 const response=await handler(new Request('https://fixture.invalid/v1/leases',{method:'POST',headers:{authorization:'Bearer invalid','content-type':'application/json'},body:'{"scenarioId":"test"}'}));
 assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'oidc_denied'});
});

test('diagnostics reveal fixed stages and known function labels, never raw stack text',()=>{
 const error=Error('PRIVATE_OIDC_123456');error.stack='Error: PRIVATE_OIDC_123456\n at PRIVATE_PASSWORD (secret.js:1:1)\n at DurableJournal.reserve (worker.js:123:1)';
 assert.deepEqual(safeFailureDetail(error,'allocate'),{stage:'allocate',errorType:'Error',reason:'unclassified_failure',frames:['DurableJournal.reserve']});
});

import {noRedirectFetch} from './cloud/transport.mjs';
test('hosted no-redirect transport rejects redirect without following or forwarding credentials',async()=>{
 const calls=[];const wrapper=noRedirectFetch(async(url,options)=>{calls.push({url,options});return new Response('',{status:302,headers:{location:'https://other.invalid/stolen'}});});
 await assert.rejects(wrapper('https://fixed.invalid/auth',{redirect:'error',headers:{authorization:'Bearer PRIVATE_TOKEN'}}),/unsafe_redirect/);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://fixed.invalid/auth');assert.equal(calls[0].options.redirect,'manual');
 const ok=noRedirectFetch(async()=>Response.json({ok:true}));assert.deepEqual(await(await ok('https://fixed.invalid/')).json(),{ok:true});
});

import {CanonicalAuthAdapter} from './canonical-auth.mjs';
function codeCheckingAdapter(unsafeIssuer=false){
 const config=JSON.parse(readFileSync(new URL('./cloud/resources.json',import.meta.url)));
 const adapter=new CanonicalAuthAdapter({config,mailbox:{receive:async()=> '123456'},assertRejectsWrongCode:true});const submissions=[];
 adapter.request=async(path,body)=>{if(path==='/api/auth/browser/start')return{attemptId:'attempt-1',pollSecret:'private',loginUrl:`${config.authOrigin}/api/auth/browser/portal?attemptId=attempt-1&ticket=proof`};if(path==='/api/auth/browser/register/code')return{};if(path==='/api/auth/browser/register'){submissions.push(body.verificationCode);return null;}if(path.startsWith('/api/auth/browser/attempts/'))return{status:unsafeIssuer||submissions.length===2?'completed':'pending'};throw Error('unexpected_route');};
 return{adapter,submissions};
}
test('cloud code assertion submits guaranteed wrong code, proves rejection, then uses actual delivered code',async()=>{
 const {adapter,submissions}=codeCheckingAdapter();await adapter.register({username:'user',email:'user@ci.invalid',password:'private',deviceIds:['device']});assert.equal(submissions.length,2);assert.notEqual(submissions[0],submissions[1]);assert.equal(submissions[1],'123456');
});
test('cloud code assertion fails closed when issuer completes a wrong-code attempt',async()=>{
 const {adapter,submissions}=codeCheckingAdapter(true);await assert.rejects(adapter.register({username:'user',email:'user@ci.invalid',password:'private',deviceIds:['device']}),/invalid_code_not_rejected/);assert.equal(submissions.length,1);
});

// D1 JS-number parameters are REAL; force that affinity in this regression.
test('janitor normalizes persisted numeric IDs for canonical TEXT children and safe ID reuse',async()=>{
 const {db,janitor,input,j}=janitorFixture();
 db.exec("CREATE TABLE account_password_credentials(user_id TEXT PRIMARY KEY,password_phc TEXT); INSERT INTO account_password_credentials VALUES('1','private');");
 const original=janitor.db;
 janitor.db={prepare(sql){let params=[];return{bind(...values){params=values;return this;},async all(){let i=0;const rewritten=sql.replace(/\?/g,()=>typeof params[i++]==='number'?'CAST(? AS REAL)':'?');return original.prepare(rewritten).bind(...params).all();}};},batch:original.batch};
 j.references(input.leaseId,{users:[1],sessions:[],principals:[],identities:[]});
 await janitor.remove(input);assert.equal((await janitor.inspect(input)).remaining,0);
 for(const table of ['account_password_credentials','account_identities','account_principals'])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
 assert.equal(db.prepare("SELECT count(*) AS n FROM account_sessions WHERE session_id='s1'").get().n,0);
 assert.deepEqual(j.references(input.leaseId).users,['1']);
 db.prepare('INSERT INTO users VALUES(?,?,?)').run(1,'new_owner','new@ci.invalid');
 db.exec("INSERT INTO account_password_credentials VALUES('1','new-private')");
 await assert.rejects(janitor.remove(input),/identity_changed/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM account_password_credentials').get().n,1);
});

test('canonical adapter releases ignored HTML and rejected response streams',async()=>{
 const config=JSON.parse(readFileSync(new URL('./cloud/resources.json',import.meta.url)));
 for(const status of [200,503]){let cancelled=false;
  const adapter=new CanonicalAuthAdapter({config,mailbox:{receive:async()=> '123456'},fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status})});
  if(status===200)assert.equal(await adapter.request('/api/auth/browser/register',{}, {html:true}),null);
  else await assert.rejects(adapter.request('/api/auth/browser/register',{}, {html:true}),/auth_request_failed/);
  assert.equal(cancelled,true);
 }
});
