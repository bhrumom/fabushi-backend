import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {CloudDeviceJanitor} from './device-janitor.mjs';
import {deviceConsumer} from './device-consumer.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REF!=='refs/heads/main'||!process.env.CLOUDFLARE_API_TOKEN)throw Error('not_configured');
const r=JSON.parse(readFileSync(new URL('./resources.json',import.meta.url)));
const mode=process.argv[2];mkdirSync('evidence',{recursive:true});
async function query(sql,params=[],database=r.accountDbId){
 if(!/^\s*(SELECT|PRAGMA)\b/i.test(sql))throw Error('read_only_inspection');
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${r.accountId}/d1/database/${database}/query`,{method:'POST',headers:{authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({sql,params}),redirect:'error',signal:AbortSignal.timeout(30000)});
 const body=await response.json();if(!response.ok||!body.success||body.result.some(x=>!x.success))throw Error('inspection_failed');return body.result.flatMap(x=>x.results);
}
function inspector(meta){
 let refs=meta.refs||null;
 const journal={get:id=>id===meta.leaseId?{accounts:meta.accounts}:null,references(_id,value){if(value)refs=value;return refs;}};
 const adapter=database=>({prepare(sql){let params=[];const stmt={bind(...v){params=v;return stmt;},async all(){return{success:true,results:await query(sql,params,database)};}};return stmt;}});
 return {janitor:new CloudDeviceJanitor(adapter(r.accountDbId),adapter(r.platformDbId),journal),refs:()=>refs};
}
async function counts(meta){
 const {janitor}=inspector(meta);let authRemaining=0,platformRemaining=0;
 for(const[table,items]of await janitor.filters(meta)){const [row]=await query(`SELECT count(*) AS n FROM ${table} WHERE ${items.map(x=>x.sql).join(' OR ')}`,items.flatMap(x=>x.values));authRemaining+=row.n;}
 for(const[table,filter]of await janitor.platformPlan(meta)){const [row]=await query(`SELECT count(*) AS n FROM ${table} WHERE ${filter.sql}`,filter.values,r.platformDbId);platformRemaining+=row.n;}
 return {authRemaining,platformRemaining,total:authRemaining+platformRemaining};
}
async function oidc(){const u=new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);u.searchParams.set('audience',r.factoryOrigin);const response=await fetch(u,{headers:{authorization:`Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},signal:AbortSignal.timeout(15000),redirect:'error'});if(!response.ok)throw Error('oidc_failed');return(await response.json()).value;}
function validate(meta){
 const owner=`bhrumom/fabushi-backend:${meta.runId}:${meta.runAttempt}:${meta.sourceSha}`;
 const id=createHash('sha256').update(`${owner}:cancelled-client`).digest('hex');
 if(meta.leaseId!==id||!Array.isArray(meta.accounts)||meta.accounts.length!==3||!Number.isFinite(meta.expiresAt)||meta.expiresAt<=meta.createdAt||meta.expiresAt-meta.createdAt>900000||!(meta.initialRemaining>0)||!(meta.initialPlatformRemaining>0)||!meta.refs)throw Error('invalid_probe_metadata');
 for(const a of meta.accounts)if(!['a','b','c'].includes(a.role)||a.username!==`ci_${id.slice(0,24)}_${a.role}`||a.email!==`ci_${id.slice(0,40)}_${a.role}@ci.invalid`||a.deviceIds.some(d=>!d.startsWith(`ci-${id.slice(0,40)}-${a.role}-`)))throw Error('invalid_probe_ownership');
}
try{
 if(mode==='prepare'){
  const token=await oidc();const response=await fetch(`${r.factoryOrigin}/v1/leases`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({scenarioId:'cancelled-client'}),redirect:'error',signal:AbortSignal.timeout(180000)});
  if(response.status!==201)throw Error('probe_allocation_failed');const lease=await response.json();
  for(const account of lease.accounts){const user=await fetch(`${r.authOrigin}/api/auth/user-info`,{headers:{authorization:`Bearer ${account.sessions[0].accessToken}`},redirect:'error',signal:AbortSignal.timeout(30000)});if(user.status!==200)throw Error('probe_login_failed');}
  const auth=(path,session,body)=>fetch(`${r.authOrigin}${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${session.accessToken}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
  await deviceConsumer({auth,check:value=>{if(!value)throw Error('device_registration_failed');}}).abandon(lease.accounts[0]);
  const health=await(await fetch(`${r.factoryOrigin}/health`,{redirect:'error',signal:AbortSignal.timeout(15000)})).json();
  const meta={runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,sourceSha:process.env.GITHUB_SHA,factorySha:health.backendSha,coreSha:health.coreSha,leaseId:lease.leaseId,expiresAt:lease.expiresAt,createdAt:Date.now(),accounts:lease.accounts.map(({role,username,email,deviceIds})=>({role,username,email,deviceIds}))};
  const inspection=inspector(meta);meta.refs=await inspection.janitor.capture(meta);const initial=await counts(meta);meta.initialRemaining=initial.total;meta.initialPlatformRemaining=initial.platformRemaining;validate(meta);
  writeFileSync('evidence/cancel-lease.json',JSON.stringify(meta,null,2));console.log('Cancellation probe has three ordinary cloud accounts and an owned device; metadata only saved. No explicit cleanup will run.');
 }else if(mode==='observe'){
  if(!/^[1-9][0-9]{0,19}$/.test(process.env.CANCEL_RUN_ID||''))throw Error('invalid_run_id');
  const response=await fetch(`https://api.github.com/repos/bhrumom/fabushi-backend/actions/runs/${process.env.CANCEL_RUN_ID}`,{headers:{authorization:`Bearer ${process.env.GITHUB_TOKEN}`,accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('cancelled_run_unavailable');const run=await response.json();
  const meta=JSON.parse(readFileSync(`${process.env.RUNNER_TEMP}/cancel-metadata/cancel-lease.json`));validate(meta);
  if(run.status!=='completed'||run.conclusion!=='cancelled'||run.path!=='.github/workflows/ci-account-factory-cancel.yml'||run.head_branch!=='main'||run.event!=='workflow_dispatch'||run.repository?.id!==1375313125||String(run.id)!==meta.runId||String(run.run_attempt)!==meta.runAttempt||run.head_sha!==meta.sourceSha)throw Error('cancelled_run_identity_mismatch');
  const report={kind:'literal-actions-cancellation-ttl',observerSha:process.env.GITHUB_SHA,observerRunId:process.env.GITHUB_RUN_ID,cancelledRunId:meta.runId,cancelledSourceSha:meta.sourceSha,factorySha:meta.factorySha,coreSha:meta.coreSha,leaseId:meta.leaseId,expiresAt:meta.expiresAt,initialRemaining:0,initialPlatformRemaining:0,overall:'FAIL'};
  const initial=await counts(meta);report.initialRemaining=initial.total;report.initialPlatformRemaining=initial.platformRemaining;
  if(report.initialPlatformRemaining<=0)throw Error('device_not_observed_live');
  if(Date.now()>=meta.expiresAt||report.initialRemaining<=0)throw Error('probe_not_observed_live_before_expiry');
  writeFileSync('evidence/cancel-observation.json',JSON.stringify(report,null,2));
  const deadline=meta.expiresAt+180000;let remaining=report.initialRemaining;
  while(Date.now()<deadline){await new Promise(ok=>setTimeout(ok,30000));const observed=await counts(meta);remaining=observed.total;report.authRemaining=observed.authRemaining;report.platformRemaining=observed.platformRemaining;if(remaining===0){if(Date.now()<meta.expiresAt)throw Error('premature_cleanup');break;}}
  report.remaining=remaining;report.observedAt=Date.now();report.overall=remaining===0?'PASS':'FAIL';
  writeFileSync('evidence/cancel-observation.json',JSON.stringify(report,null,2));if(remaining!==0)throw Error('cancelled_client_ttl_residual');console.log('Actually cancelled Actions client: independent cloud wall-clock TTL removed every owned auth and device row.');
 }else throw Error('invalid_mode');
}catch{console.error('cancellation_probe_failed; inspect sanitized metadata and Actions step status');process.exitCode=1;}
