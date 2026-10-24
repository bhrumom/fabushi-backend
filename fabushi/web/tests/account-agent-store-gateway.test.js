import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { routeAccountAgentStoreGateway } from '../src/routes/account-agent-store-gateway.js';

function request(path, method='GET', body) {
  return new Request(`https://api.ombhrum.com${path}`, { method,
    headers: { authorization:'Bearer native-fixture-token','x-fabushi-device-id':'device-a','idempotency-key':'op-a','content-type':'application/json' },
    body:body===undefined?undefined:JSON.stringify(body),
  });
}

test('native Agent file request reaches only the existing owner with method/body/query/auth intact', async()=>{
  const path='/v1/account/agents/agent-a/store?path=notes%2Fa.txt';
  let count=0;
  const response=await routeAccountAgentStoreGateway({pathname:new URL(`https://api.ombhrum.com${path}`).pathname,
    request:request(path,'PUT',{path:'notes/a.txt',dataBase64:'aGVsbG8=',baseEtag:'previous'}),
    fetchImpl:async(outgoing,options)=>{
      count++;
      assert.equal(outgoing.url,`https://ai.ombhrum.com${path}`);
      assert.equal(outgoing.method,'PUT');
      assert.equal(outgoing.headers.get('authorization'),'Bearer native-fixture-token');
      assert.equal(outgoing.headers.get('x-fabushi-device-id'),'device-a');
      assert.equal(outgoing.headers.get('idempotency-key'),'op-a');
      assert.equal(options.redirect,'manual');
      assert.deepEqual(await outgoing.json(),{path:'notes/a.txt',dataBase64:'aGVsbG8=',baseEtag:'previous'});
      return Response.json({outcome:'conflict',conflictPath:'.conflicts/op-a/a.txt'},{status:409});
    }});
  assert.equal(count,1); assert.equal(response.status,409);
  assert.equal(response.headers.get('x-fabushi-agent-store-owner'),'existing-node-account-store');
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await response.json()).outcome,'conflict');
});

test('only declared account routes are selected; other native APIs retain their owner',async()=>{
  for(const path of ['/v1/devices','/v1/ai/usage','/v1/extensions','/v1/automation-runs','/v1/account/agents-extra','/v1/account/agents/a/other']) {
    assert.equal(await routeAccountAgentStoreGateway({pathname:path,request:request(path),fetchImpl:()=>{throw Error('must not fetch');}}),null);
  }
  for(const [path,method] of [['/v1/account/agents','GET'],['/v1/account/agents/a','GET'],['/v1/account/agents/a','PUT'],['/v1/account/agents/a/store','DELETE'],['/v1/account/bots','GET'],['/v1/account/bots/a/add','POST'],['/v1/account/bots/a/add','DELETE'],['/v1/account/sync','GET']]) {
    let called=0;
    const r=await routeAccountAgentStoreGateway({pathname:path,request:request(path,method),fetchImpl:async()=>{called++;return Response.json({error:'unauthorized'},{status:401});}});
    assert.equal(r.status,401); assert.equal(called,1);
  }
});

test('unsupported methods cannot write through collection or sync reads',async()=>{
  for(const path of ['/v1/account/agents','/v1/account/bots','/v1/account/sync']) {
    const r=await routeAccountAgentStoreGateway({pathname:path,request:request(path,'POST',{}),fetchImpl:()=>{throw Error('must not fetch');}});
    assert.equal(r.status,405); assert.equal(r.headers.get('allow'),'GET');
  }
});

test('lost upstream outcome is not retried or failed over',async()=>{
  let attempts=0;
  const path='/v1/account/agents/a/store';
  const r=await routeAccountAgentStoreGateway({pathname:path,request:request(path,'PUT',{path:'a.txt',dataBase64:'YQ=='}),
    fetchImpl:async()=>{attempts++;throw Error('committed but response lost: private fixture');}});
  assert.equal(attempts,1); assert.equal(r.status,502);
  const body=await r.text(); assert.ok(body.includes('unknown')); assert.ok(!body.includes('private fixture')); assert.ok(!body.includes('native-fixture-token'));
});

test('redirects cannot move private account operations to another service',async()=>{
  let attempts=0; const path='/v1/account/agents';
  const r=await routeAccountAgentStoreGateway({pathname:path,request:request(path),fetchImpl:async()=>{attempts++;return new Response('redirect',{status:307,headers:{location:'https://foreign.invalid'}});}});
  assert.equal(attempts,1); assert.equal(r.status,502); assert.equal(r.headers.get('location'),null);
});

test('specific existing account owner runs before the broad Core gateway',()=>{
  const router=readFileSync(new URL('../src/router.js',import.meta.url),'utf8');
  assert.ok(router.indexOf('  routeAccountAgentStoreGateway,')<router.indexOf('  routePlatformGateway,'));
});
