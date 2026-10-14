import assert from "node:assert/strict";
import test from "node:test";

import {
  FdnEnrollmentBrokerClient,
  authorizeEnrollmentForAccount,
} from "../src/fdn_network_enrollment_proxy.js";

const TOKEN="t".repeat(64);
const GRANT_ID="network-enroll-0123456789abcdef0123456789abcdef";
const SECRET="g".repeat(96);

test("broker client only permits HTTPS or explicit loopback HTTP",()=>{
  assert.doesNotThrow(()=>new FdnEnrollmentBrokerClient({baseUrl:"https://fdn.internal.example",token:TOKEN,fetchImpl:async()=>{}}));
  assert.doesNotThrow(()=>new FdnEnrollmentBrokerClient({baseUrl:"http://127.0.0.1:8793",token:TOKEN,fetchImpl:async()=>{}}));
  assert.throws(()=>new FdnEnrollmentBrokerClient({baseUrl:"http://10.0.0.2:8793",token:TOKEN,fetchImpl:async()=>{}}),e=>e.code==="fdn_enrollment_broker_url_invalid");
  assert.throws(()=>new FdnEnrollmentBrokerClient({baseUrl:"https://user:pass@fdn.example",token:TOKEN,fetchImpl:async()=>{}}),e=>e.code==="fdn_enrollment_broker_url_invalid");
});

test("client forwards only exact grant input and broker credential",async()=>{
  let seen;
  const client=new FdnEnrollmentBrokerClient({
    baseUrl:"https://fdn.internal.example",
    token:TOKEN,
    fetchImpl:async(url,options)=>{
      seen={url,options};
      return {ok:true,status:200,async json(){return {ok:true,enrollment:{grantId:GRANT_ID,generation:2},target:{userId:"user:one",deviceId:"device-1",cellId:"cell-abcdefghijklmnop",generation:2}};}};
    }
  });
  await client.start({grantId:GRANT_ID,grantSecret:SECRET});
  assert.equal(seen.url,"https://fdn.internal.example/v1/internal/fdn/enrollment/start");
  assert.equal(seen.options.headers.authorization,`Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(seen.options.body),{grantId:GRANT_ID,grantSecret:SECRET});
  assert.throws(()=>client.start({grantId:GRANT_ID,grantSecret:SECRET,userId:"user:one"}),e=>e.code==="fdn_enrollment_request_invalid");
});

test("account authorization requires real authenticated Fabushi subject",()=>{
  const payload={ok:true,enrollment:{grantId:GRANT_ID,generation:4,authKey:"secret-key"},target:{userId:"user:one",deviceId:"device-1",cellId:"cell-abcdefghijklmnop",generation:4}};
  assert.throws(()=>authorizeEnrollmentForAccount({userId:"user:one",isAuthenticated:false},payload),e=>e.code==="fdn_enrollment_auth_required");
  assert.throws(()=>authorizeEnrollmentForAccount({userId:"user:other",isAuthenticated:true},payload),e=>e.code==="fdn_enrollment_account_mismatch");
  const projected=authorizeEnrollmentForAccount({userId:"user:one",isAuthenticated:true},payload);
  assert.equal(projected.authKey,"secret-key");
  assert.equal(projected.deviceId,"device-1");
});

test("account authorization rejects broker generation mismatch",()=>{
  const payload={ok:true,enrollment:{grantId:GRANT_ID,generation:5},target:{userId:"user:one",deviceId:"device-1",cellId:"cell-abcdefghijklmnop",generation:4}};
  assert.throws(()=>authorizeEnrollmentForAccount({userId:"user:one",isAuthenticated:true},payload),e=>e.code==="fdn_enrollment_generation_mismatch");
});

test("broker failures keep raw upstream detail out of public error object",async()=>{
  const client=new FdnEnrollmentBrokerClient({
    baseUrl:"https://fdn.internal.example",
    token:TOKEN,
    fetchImpl:async()=>({ok:false,status:409,async json(){return {ok:false,error:{code:"redeem_outcome_unknown",message:`leak ${SECRET}`,recoverable:true}};}})
  });
  await assert.rejects(()=>client.start({grantId:GRANT_ID,grantSecret:SECRET}),e=>{
    assert.equal(e.code,"redeem_outcome_unknown");
    assert.equal(String(e.message).includes(SECRET),false);
    return true;
  });
});
