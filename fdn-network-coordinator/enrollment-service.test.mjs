import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createEnrollmentService } from "./enrollment-service.mjs";

const TOKEN = "s".repeat(64);
const GRANT_ID = "network-enroll-0123456789abcdef0123456789abcdef";
const TARGET = { userId:"user:one", deviceId:"device-1", cellId:"cell-abcdefghijklmnop", generation:4 };

class Store {
  read() {
    return {version:1,enrollments:{[GRANT_ID]:{grantId:GRANT_ID,...TARGET}}};
  }
}

async function request(port,{path,token=TOKEN,body={}}) {
  return await new Promise((resolve,reject)=>{
    const req=http.request({
      host:"127.0.0.1",port,path,method:"POST",
      headers:{"content-type":"application/json","authorization":`Bearer ${token}`}
    },res=>{
      let raw=""; res.setEncoding("utf8"); res.on("data",c=>raw+=c); res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(raw)}));
    });
    req.on("error",reject);
    req.end(JSON.stringify(body));
  });
}

async function withService(broker, fn) {
  const service=createEnrollmentService({broker,store:new Store(),serviceToken:TOKEN});
  await new Promise((resolve,reject)=>{service.once("error",reject);service.listen(0,"127.0.0.1",resolve);});
  try {
    const addr=service.address();
    await fn(addr.port);
  } finally {
    await new Promise(resolve=>service.close(resolve));
  }
}

test("service rejects missing/incorrect broker credential before broker call", async()=>{
  let calls=0;
  await withService({async start(){calls+=1;}}, async port=>{
    const res=await request(port,{path:"/v1/internal/fdn/enrollment/start",token:"x".repeat(64),body:{grantId:GRANT_ID,grantSecret:"g".repeat(100)}});
    assert.equal(res.status,401);
    assert.equal(res.body.error.code,"unauthorized");
    assert.equal(calls,0);
    assert.equal(res.headers["cache-control"],"no-store");
  });
});

test("start returns broker result plus Core-derived target projection", async()=>{
  await withService({
    async start(input){
      assert.deepEqual(Object.keys(input).sort(),["grantId","grantSecret"]);
      return {grantId:input.grantId,authKey:"hskey-auth-redacted",cellId:TARGET.cellId,generation:4,expiresAt:4102444800};
    }
  }, async port=>{
    const res=await request(port,{path:"/v1/internal/fdn/enrollment/start",body:{grantId:GRANT_ID,grantSecret:"g".repeat(100)}});
    assert.equal(res.status,200);
    assert.equal(res.body.ok,true);
    assert.deepEqual(res.body.target,TARGET);
    assert.equal(res.body.enrollment.grantId,GRANT_ID);
  });
});

test("complete returns same target identity and never accepts route authority", async()=>{
  await withService({
    async complete(input){
      assert.deepEqual(input,{grantId:GRANT_ID});
      return {grantId:GRANT_ID,completed:true,nodeId:"100.64.0.10",generation:4};
    }
  }, async port=>{
    const res=await request(port,{path:"/v1/internal/fdn/enrollment/complete",body:{grantId:GRANT_ID}});
    assert.equal(res.status,200);
    assert.deepEqual(res.body.target,TARGET);
    assert.equal(res.body.enrollment.nodeId,"100.64.0.10");
  });
});

test("service does not reflect internal error messages or secrets", async()=>{
  await withService({
    async start(){ throw Object.assign(new Error("secret grant value must not escape"),{code:"network_outcome_unknown"}); }
  }, async port=>{
    const res=await request(port,{path:"/v1/internal/fdn/enrollment/start",body:{grantId:GRANT_ID,grantSecret:"g".repeat(100)}});
    assert.equal(res.status,500);
    assert.equal(res.body.error.code,"enrollment_failed");
    assert.equal(JSON.stringify(res.body).includes("secret grant value"),false);
  });
});
