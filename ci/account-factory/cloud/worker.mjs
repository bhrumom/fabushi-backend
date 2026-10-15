import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { AccountFactory, requireIsolation } from '../factory-core.mjs';
import { CanonicalAuthAdapter } from '../canonical-auth.mjs';
import { fixtureHandler } from '../service.mjs';
import { DurableJournal } from './journal.mjs';
import { CloudJanitor } from './janitor.mjs';
import { failureCategory, observedAuthFetch, safeFailureDetail } from './diagnostics.mjs';
import { noRedirectFetch } from './transport.mjs';

const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
function configuration(env) {
  const config=JSON.parse(env.ISOLATION_CONFIG);
  requireIsolation(config);
  if(config.environment!=='ci-isolated' || env.ENVIRONMENT!=='ci-isolated' || !env.ACCOUNT_DB || !env.PLATFORM_DB) throw Error('not_configured');
  return config;
}
function bridgeAuthorized(request,env) {
  const supplied=Buffer.from(request.headers.get('x-fabushi-auth-bridge')||'');
  const expected=Buffer.from(env.AUTH_PROVIDER_BRIDGE_SECRET||'');
  return expected.length>=32 && supplied.length===expected.length && timingSafeEqual(supplied,expected);
}
export class AccountLeaseOwner extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env); this.env=env; const config=configuration(env);
    this.journal=new DurableJournal(ctx.storage);
    const auth=new CanonicalAuthAdapter({config,fetchImpl:observedAuthFetch(value=>{this.diagnostic=value;},noRedirectFetch()),mailbox:{receive:async({email})=>this.journal.consume(email)}});
    this.janitor=new CloudJanitor(env.ACCOUNT_DB,this.journal);
    this.factory=new AccountFactory({config,journal:this.journal,auth,janitor:this.janitor,quota:10,ttlMs:900000});
    this.handler=fixtureHandler({factory:this.factory,oidcOptions:{fetchImpl:noRedirectFetch()},policy:JSON.parse(env.OIDC_POLICY),onError:(error,stage)=>{this.diagnostic={...this.diagnostic,...safeFailureDetail(error,stage)};}});
    this.tail=Promise.resolve();
  }
  serialize(action) { const work=this.tail.then(action); this.tail=work.then(()=>{},()=>{}); return work; }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path.startsWith('/api/internal/auth-provider/')) {
      if(!bridgeAuthorized(request,this.env)) return json({error:'denied'},403);
      if(path==='/api/internal/auth-provider/capabilities' && request.method==='GET') return json({email:true,alipay:false});
      if(path==='/api/internal/auth-provider/email/send-registration-code' && request.method==='POST') {
        try {
          const reader=request.body?.getReader(); if(!reader) return json({error:'invalid_request'},400);
          let size=0; const chunks=[];
          while(true) { const {value,done}=await reader.read(); if(done) break; size+=value.byteLength; if(size>4096){await reader.cancel();return json({error:'invalid_request'},413);} chunks.push(value); }
          const {email,code}=JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
          this.journal.deliver(email,code); return json({ok:true});
        } catch { return json({error:'mail_denied'},400); }
      }
      return json({error:'not_found'},404);
    }
    // Internal-only invocation by scheduled(); outer Worker never forwards this
    // path from public requests. No public cleanup credentials exist.
    if(path==='/__scheduled_sweep') return this.serialize(async()=>{
      const results=await this.factory.sweep(); this.journal.purgeMail();
      return json({status:results.some(r=>r.status==='blocked')?'blocked':'ok',results});
    });
    return this.serialize(async()=>{
      this.diagnostic=null;
      const response=await this.handler(request);
      if(response.status===201){
        // Capture non-secret stable IDs before returning credentials. Later
        // profile changes cannot hide owned child rows from residual inspection.
        const {leaseId}=await response.clone().json();
        const lease=this.journal.get(leaseId);
        try{await this.janitor.capture({leaseId,accounts:lease.accounts});}
        catch(error){return json({error:'cleanup_tracking_failed',diagnostic:{reason:failureCategory(error)}},503);}
      }
      if(response.status===503 && this.diagnostic){const body=await response.json();return json({...body,diagnostic:this.diagnostic},503);}
      return response;
    });
  }
}
export default {
  async fetch(request,env) {
    try {
      configuration(env); const path=new URL(request.url).pathname;
      if(path==='/health' && request.method==='GET') return json({status:'ok',environment:'ci-isolated',backendSha:env.BACKEND_SHA,coreSha:env.CORE_SHA,scope:'cloud-auth-test-mailbox'});
      if(!(path==='/v1/leases' || /^\/v1\/leases\/[a-f0-9]{64}$/.test(path) || path.startsWith('/api/internal/auth-provider/'))) return json({error:'not_found'},404);
      return env.LEASE_OWNER.get(env.LEASE_OWNER.idFromName('leases-v1')).fetch(request);
    } catch { return json({error:'not_configured'},503); }
  },
  async scheduled(_event,env,ctx) {
    configuration(env);
    ctx.waitUntil(env.LEASE_OWNER.get(env.LEASE_OWNER.idFromName('leases-v1')).fetch(new Request('https://internal/__scheduled_sweep')).then(async r=>{
      const report=await r.json(); if(report.status!=='ok') throw Error('ttl_cleanup_blocked');
      console.log(JSON.stringify({event:'lease-sweep',sourceSha:env.BACKEND_SHA,cleaned:report.results.length,status:report.status}));
    }));
  },
};
