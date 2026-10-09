import test from 'node:test';
import assert from 'node:assert/strict';
import { routePlatformGateway } from '../src/routes/platform-gateway-routes.js';
const env={MAHAYANA_PLATFORM:{fetch:async req=>{assert.equal(new URL(req.url).hostname,'mahayana-platform.bhrumom.workers.dev'); return new Response(null,{status:302,headers:{Location:'https://accounts.google.com/o/oauth2/v2/auth?state=opaque'}});}}};
test('MCP consent and callback paths preserve browser redirects through the canonical platform',async()=>{
  for(const path of ['/api/mcp/oauth/authorize?ticket=opaque','/api/mcp/oauth/callback?state=opaque&code=code','/api/mcp/connections/grant/refresh']){
    const request=new Request('https://api.ombhrum.com'+path);
    const response=await routePlatformGateway({pathname:new URL(request.url).pathname,request,env});
    assert.equal(response.status,302); assert.match(response.headers.get('Location'),/^https:\/\/accounts.google.com\//);
    assert.equal(response.headers.get('X-Fabushi-Control-Plane'),'mahayana-platform');
  }
});
test('Uncertain MCP mutations never fall back to another upstream execution',async()=>{
  let calls=0; const original=globalThis.fetch; globalThis.fetch=async()=>{calls++;throw new Error('must not retry');};
  try{
    const request=new Request('https://api.ombhrum.com/api/mcp/connections/grant/refresh',{method:'POST',body:'{}'});
    const response=await routePlatformGateway({pathname:new URL(request.url).pathname,request,env:{MAHAYANA_PLATFORM:{fetch:async()=>{throw new Error('lost after rotation');}}}});
    assert.equal(response.status,502); assert.equal(calls,0); assert.equal(response.headers.get('Cache-Control'),'no-store');
  }finally{globalThis.fetch=original;}
});
test('Other MCP-like paths remain with their existing owner',async()=>{
  const request=new Request('https://api.ombhrum.com/api/mcp/custom');
  assert.equal(await routePlatformGateway({pathname:'/api/mcp/custom',request,env}),null);
});
