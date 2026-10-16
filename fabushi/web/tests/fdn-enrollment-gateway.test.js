import test from 'node:test';
import assert from 'node:assert/strict';
import {routeFdnEnrollmentGateway} from '../src/routes/fdn-enrollment-gateway.js';
const start='/api/fdn/network-enrollment/start',complete='/api/fdn/network-enrollment/complete';
function input(path=start,options={}) {return new Request('https://api.ombhrum.com'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer fixture-user','Cookie':'private-cookie','X-Fabushi-Network-Authority':'private-authority'},body:'{"grantId":"fixture"}',...options});}
test('exact start and complete preserve body/account credential and strip other authority',async()=>{
 for(const path of [start,complete]){
  let calls=0;
  const result=await routeFdnEnrollmentGateway({pathname:path,request:input(path),fetchImpl:async request=>{
   calls++;assert.equal(request.url,'https://ai.ombhrum.com'+path);assert.equal(request.method,'POST');
   assert.equal(request.headers.get('authorization'),'Bearer fixture-user');assert.equal(request.headers.get('cookie'),null);assert.equal(request.headers.get('x-fabushi-network-authority'),null);
   assert.equal(request.redirect,'manual');assert.equal(await request.text(),'{"grantId":"fixture"}');return new Response('{"error":"unauthorized"}',{status:401,headers:{'Set-Cookie':'private-session','X-Private':'private'}});
  }});
  assert.equal(calls,1);assert.equal(result.status,401);assert.equal(result.headers.get('x-fabushi-fdn-owner'),'existing-account-api');assert.equal(result.headers.get('set-cookie'),null);assert.equal(result.headers.get('x-private'),null);assert.equal(result.headers.get('cache-control'),'no-store');
 }
});
test('unknown paths are unclaimed and invalid route/method/media/body never dispatch',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;throw new Error('must not dispatch');};
 assert.equal(await routeFdnEnrollmentGateway({pathname:start+'/extra',request:input(start+'/extra'),fetchImpl}),null);
 for(const [request,status] of [
  [input(start+'?url=https://attacker.invalid'),400],
  [input(start,{method:'GET',body:undefined}),405],
  [input(start,{headers:{'Content-Type':'text/plain'}}),415],
  [input(start,{body:'x'.repeat(64*1024+1)}),413],
 ])assert.equal((await routeFdnEnrollmentGateway({pathname:start,request,fetchImpl})).status,status);
 assert.equal(calls,0);
});
test('uncertain network response is one dispatch and secret-free generic error',async()=>{
 let calls=0;const response=await routeFdnEnrollmentGateway({pathname:start,request:input(),fetchImpl:async()=>{calls++;throw new Error('private-authority private-cookie secret-response');}});
 assert.equal(calls,1);assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'enrollment_owner_unavailable'});
});
test('redirect is not followed or exposed',async()=>{
 let calls=0;const response=await routeFdnEnrollmentGateway({pathname:complete,request:input(complete),fetchImpl:async()=>{calls++;return new Response(null,{status:307,headers:{Location:'https://attacker.invalid'}});}});
 assert.equal(calls,1);assert.equal(response.status,502);assert.equal(response.headers.get('location'),null);
});
