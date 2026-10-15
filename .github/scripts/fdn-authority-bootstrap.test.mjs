import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, generateAuthority, publishOnce, publicError } from './fdn-authority-bootstrap.mjs';
test('preflight never mutates any existing/partial state', () => {
  for (const core of [false,true]) for (const stage of [false,true]) assert.equal(plan(core,stage,false),'preflight-only');
});
test('existing Core authority without server material fails closed', () => assert.throws(()=>plan(true,false,true), /existing_authority_without_server_material/));
test('staged and published material reconciles without key rotation', () => {
  assert.equal(plan(true,true,true),'reconcile-existing'); assert.equal(plan(false,true,true),'publish-staged'); assert.equal(plan(false,false,true),'initialize-once');
});
test('service authority is independent cryptographic48-byte material', () => {
  const a=generateAuthority(),b=generateAuthority(); assert.match(a,/^[a-f0-9]{96}$/); assert.equal(Buffer.from(a,'hex').length,48); assert.notEqual(a,b);
});
test('lost publish response is unknown and never retried', async () => {
  let calls=0; await assert.rejects(()=>publishOnce(async()=>{calls++;throw Error('secret-bearing transport error');},'https://example.invalid','test-api',generateAuthority()),/authority_publish_outcome_unknown/); assert.equal(calls,1);
});
test('redirect or rejected mutation is never treated as configured', async () => {
  let calls=0; await assert.rejects(()=>publishOnce(async(_url,options)=>{calls++;assert.equal(options.redirect,'error');return new Response(JSON.stringify({success:false}),{status:403});},'https://example.invalid','test-api',generateAuthority()),/authority_publish_rejected/);assert.equal(calls,1);
});
test('public failure diagnostics cannot expose raw secret-bearing errors', () => {
  assert.equal(publicError(Error('secret-api-token-password')),'authority_bootstrap_failed'); assert.equal(publicError(Error('core_route_unavailable')),'core_route_unavailable');
});
