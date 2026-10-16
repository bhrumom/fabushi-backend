import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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


function entryFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),"fdn-entry-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const link=join(dir,"current");
  symlinkSync(fileURLToPath(new URL(".",import.meta.url)),link,"dir");
  return {dir,entry:join(link,"enrollment-service.mjs")};
}

test("symlink entry runs validation and fails closed rather than exiting zero",t=>{
  const {entry}=entryFixture(t);
  const result=spawnSync(process.execPath,[entry],{encoding:"utf8",env:{...process.env,FABUSHI_FDN_ENROLLMENT_LISTEN_HOST:"0.0.0.0"}});
  assert.equal(result.status,1,result.stderr);
  assert.equal(result.stdout,"");
  assert.deepEqual(JSON.parse(result.stderr),{error:"non_loopback_forbidden"});
});

test("actual symlink entry stays listening and denies unauthenticated enrollment",{timeout:10000},async t=>{
  const {dir,entry}=entryFixture(t);
  const reserve=http.createServer();
  await new Promise(resolve=>reserve.listen(0,"127.0.0.1",resolve));
  const port=reserve.address().port;
  await new Promise(resolve=>reserve.close(resolve));
  const child=spawn(process.execPath,[entry],{env:{...process.env,
    FABUSHI_FDN_ENROLLMENT_LISTEN_HOST:"127.0.0.1",FABUSHI_FDN_ENROLLMENT_PORT:String(port),
    FABUSHI_FDN_ENROLLMENT_STATE_PATH:join(dir,"state.json"),
    FABUSHI_PLATFORM_CORE_URL:"https://core.invalid",FDN_NETWORK_AUTHORITY_TOKEN:"a".repeat(64),
    FABUSHI_FDN_CELL_ID:"cell-abcdefghijklmnop",FABUSHI_FDN_ENROLLMENT_BROKER_TOKEN:TOKEN,
    FABUSHI_FDN_ENROLLMENT_STATE_KEY_B64:Buffer.alloc(32,7).toString("base64"),
  },stdio:["ignore","pipe","pipe"]});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGTERM");await done;}});
  await new Promise((resolve,reject)=>{
    let out="",err="";const timer=setTimeout(()=>reject(new Error("entry readiness timed out")),5000);
    child.stderr.on("data",chunk=>{err+=chunk.toString();});
    child.once("exit",()=>{clearTimeout(timer);reject(new Error("entry exited before ready: "+err));});
    child.stdout.on("data",chunk=>{out+=chunk.toString();if(out.includes("\n")){clearTimeout(timer);try{assert.deepEqual(JSON.parse(out.trim()),{ready:true,host:"127.0.0.1",port});resolve();}catch(e){reject(e);}}});
  });
  const res=await request(port,{path:"/v1/internal/fdn/enrollment/start",token:"x".repeat(64)});
  assert.equal(res.status,401);assert.equal(res.body.error.code,"unauthorized");
});
