import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REF!=='refs/heads/main')throw Error('actions_only');
const r=JSON.parse(readFileSync(new URL('./resources.json',import.meta.url)));
const assertions={};const report={kind:'hosted-account-lifecycle',backendSha:process.env.GITHUB_SHA,coreSha:process.env.CORE_SHA,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,d1Mode:'remote-cloud',mailTransport:'isolated-cloud-bridge; SMTP NOT_VERIFIED',packagedCrossDeviceE2E:'NOT_VERIFIED',assertions,leases:[],overall:'FAIL'};
mkdirSync('evidence',{recursive:true});let oidc,active;
const check=(value,id)=>{if(!value)throw Error(`assertion_failed:${id}`);assertions[id]='PASS';};
async function identity(){const u=new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);u.searchParams.set('audience',r.factoryOrigin);const response=await fetch(u,{headers:{authorization:`Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('oidc_unavailable');const {value}=await response.json();if(!value)throw Error('oidc_unavailable');return value;}
const fixture=(path,method='GET',body,token=oidc)=>fetch(`${r.factoryOrigin}${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(180000)});
const auth=(path,session,body)=>fetch(`${r.authOrigin}${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${session.accessToken}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
async function allocate(scenarioId){const response=await fixture('/v1/leases','POST',{scenarioId});if(response.status!==201){const failure=await response.json().catch(()=>({}));report.allocationFailure={status:response.status,error:failure.error,diagnostic:failure.diagnostic};throw Error(`cloud_allocation_failed:${response.status}`);}const lease=await response.json();report.leases.push({leaseId:lease.leaseId,expiresAt:lease.expiresAt,accounts:lease.accounts.map(({username,email,deviceIds})=>({username,email,deviceIds}))});return lease;}
try{
 oidc=await identity();
 const health=await(await fetch(`${r.factoryOrigin}/health`,{signal:AbortSignal.timeout(15000),redirect:'error'})).json();report.observedFactorySha=/^[a-f0-9]{40}$/.test(health.backendSha||'')?health.backendSha:'invalid';report.observedCoreSha=/^[a-f0-9]{40}$/.test(health.coreSha||'')?health.coreSha:'invalid';check(health.backendSha===process.env.GITHUB_SHA&&health.coreSha===process.env.CORE_SHA,'exactDeployedSource');
 check((await fixture('/v1/leases','POST',{scenarioId:'denied'},'invalid')).status===401,'invalidOidcDenied');
 check((await fixture('/__scheduled_sweep','POST')).status===404,'publicSweepDenied');
 active=await allocate('cloud-lifecycle');check(active.otpRejectionChecked===true,'invalidVerificationCodeDenied');const [a,b,c]=active.accounts;
 check(active.accounts.length===3&&a.sessions.length===2&&new Set(active.accounts.map(x=>String(x.sessions[0].user.id))).size===3,'ordinaryRegistrationCodeAndLogin');
 const infos=[];for(const session of a.sessions){const response=await auth('/api/auth/user-info',session);if(response.status!==200)throw Error('multi_session_denied');infos.push(await response.json());}
 check(infos.every(x=>String(x.id??x.user?.id)===String(a.sessions[0].user.id)),'sameAccountTwoSessions');
 const br=await auth('/api/auth/user-info',b.sessions[0]);const bi=await br.json();check(br.status===200&&String(bi.id??bi.user?.id)===String(b.sessions[0].user.id)&&String(b.sessions[0].user.id)!==String(a.sessions[0].user.id),'independentAccounts');
 check((await fetch(`${r.authOrigin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:b.username,password:a.password,deviceId:b.deviceIds[0]}),signal:AbortSignal.timeout(30000),redirect:'error'})).status===401,'crossAccountPasswordDenied');
 const rr=await auth('/api/auth/refresh',c.sessions[0],{refreshToken:c.sessions[0].refreshToken});if(rr.status!==200)throw Error('refresh_failed');const rotated=await rr.json();check(rotated.refreshToken!==c.sessions[0].refreshToken,'refreshRotation');
 check((await auth('/api/auth/logout',rotated,{})).status===200&&(await auth('/api/auth/user-info',rotated)).status===401&&(await auth('/api/auth/refresh',rotated,{refreshToken:rotated.refreshToken})).status===401,'revocation');
 check((await auth('/api/auth/user-info',a.sessions[1])).status===200,'otherSessionRetained');
 const deleted=await fixture(`/v1/leases/${active.leaseId}`,'DELETE');const cleaned=await deleted.json();check(deleted.status===200&&cleaned.remaining===0,'explicitZeroResidualCleanup');
 check((await auth('/api/auth/user-info',a.sessions[0])).status===401,'deletedSessionDenied');active=null;
 const orphan=await allocate('cloud-abandoned-client');
 // Allocation client has completed and sends no cleanup/sweep request. Only the
 // independently deployed cloud scheduler may reclaim this lease.
 const deadline=orphan.expiresAt+180000;let denied=false;
 while(Date.now()<deadline){if(Date.now()>orphan.expiresAt){const response=await auth('/api/auth/user-info',orphan.accounts[0].sessions[0]);if(response.status===401){denied=true;break;}}await new Promise(ok=>setTimeout(ok,30000));}
 check(denied,'independentWallClockTTL');
 oidc=await identity();const verifyCleanup=await fixture(`/v1/leases/${orphan.leaseId}`,'DELETE');check(verifyCleanup.status===200&&(await verifyCleanup.json()).remaining===0,'ttlZeroResidualConfirmation');
 report.overall='PASS';report.testCount=Object.keys(assertions).length;console.log(`Cloud auth lifecycle: ${report.testCount} assertions PASS; SMTP and packaged device E2E NOT_VERIFIED.`);
}catch(error){console.error(error.message?.startsWith('assertion_failed:')||error.message?.startsWith('cloud_allocation_failed:')?error.message:'cloud_acceptance_failed');process.exitCode=1;}
finally{
 if(active){try{oidc=await identity();const cleanup=await fixture(`/v1/leases/${active.leaseId}`,'DELETE');if(cleanup.status!==200)report.cleanup='blocked';}catch{report.cleanup='blocked';}}
 writeFileSync('evidence/cloud-runtime.json',JSON.stringify(report,null,2));
}
