// Cloud mutations only from the trusted main Actions environment.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { requireIsolation } from '../factory-core.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REF!=='refs/heads/main'||!process.env.CLOUDFLARE_API_TOKEN) throw Error('not_configured');
const r=JSON.parse(readFileSync(new URL('./resources.json',import.meta.url)));requireIsolation(r);
const root=`https://api.cloudflare.com/client/v4/accounts/${r.accountId}`;
async function api(path,method='GET',body,allowMissing=false){
 const res=await fetch(root+path,{method,headers:{authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(60000)});
 const data=await res.json();if(allowMissing && res.status===404)return null;
 if(!res.ok||data.success!==true)throw Error(`cloud_api_failed:${method}:${path.split('/').slice(0,3).join('/')}:${res.status}`);
 return data.result;
}
async function query(db,sql,params=[]){const results=await api(`/d1/database/${db}/query`,'POST',{sql,params});if(results.some(x=>!x.success))throw Error('cloud_sql_failed');return results.flatMap(x=>x.results||[]);}
const dir=join(process.env.RUNNER_TEMP,'cloud-accounts');
const wrangler=join(process.env.RUNNER_TEMP,'cloud-tools/node_modules/.bin/wrangler');
const schemas=join('core','third_party/mahayana/mahayana-rs/mahayana-platform-worker/account-migrations');
const schemaFiles=readdirSync(schemas).filter(n=>/^000[1-7]_.*\.sql$/.test(n)).sort();if(schemaFiles.length!==7)throw Error('schema_pin_mismatch');
const schema=readFileSync('fabushi/web/schema.sql','utf8')+'\nALTER TABLE users ADD COLUMN user_no INTEGER;\n'+schemaFiles.map(n=>readFileSync(join(schemas,n),'utf8')).join('\n');
const schemaDigest=createHash('sha256').update(schema).digest('hex');
const report={backendSha:process.env.GITHUB_SHA,coreSha:process.env.CORE_SHA,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,resources:r,schemaDigest,status:'FAIL',scope:'cloud-auth-test-mailbox'};
mkdirSync('evidence',{recursive:true});
try{
 for(const [id,name] of [[r.accountDbId,'fabushi-ci-isolated-accounts'],[r.platformDbId,'fabushi-ci-isolated-platform']]){const actual=await api(`/d1/database/${id}`);if(actual.uuid!==id||actual.name!==name)throw Error('database_inventory_mismatch');}
 const sub=await api('/workers/subdomain');if(sub.subdomain!=='bhrumom')throw Error('workers_subdomain_mismatch');
 const before=[];for(const worker of [r.authWorker,r.factoryWorker])before.push(await api(`/workers/scripts/${worker}/settings`,'GET',undefined,true));
 if(Boolean(before[0])!==Boolean(before[1]))throw Error('partial_deployment_requires_recovery');
 const existing=await query(r.accountDbId,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'");
 if(existing.some(x=>x.name==='ci_fixture_schema')){const [version]=await query(r.accountDbId,'SELECT digest FROM ci_fixture_schema');if(version?.digest!==schemaDigest)throw Error('schema_change_requires_migration');}
 else {if(existing.length)throw Error('nonempty_unowned_database');await query(r.accountDbId,schema);await query(r.accountDbId,'CREATE TABLE ci_fixture_schema(digest TEXT NOT NULL)');await query(r.accountDbId,'INSERT INTO ci_fixture_schema VALUES(?)',[schemaDigest]);}
 for(const name of ['factory','auth']) {
  execFileSync(wrangler,['deploy','--config',join(dir,`${name}.json`)],{stdio:['ignore','pipe','pipe'],timeout:180000});
 }
 if(!before[0]){
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const bridge=randomBytes(32).toString('hex');
  const keySecrets={ACCESS_TOKEN_PRIVATE_KEY_PEM:privateKey.export({type:'pkcs8',format:'pem'}),ACCESS_TOKEN_PUBLIC_KEY_PEM:publicKey.export({type:'spki',format:'pem'}),AUTH_PROVIDER_BRIDGE_SECRET:bridge};
  for(const [worker,secrets]of [[r.authWorker,keySecrets],[r.factoryWorker,{AUTH_PROVIDER_BRIDGE_SECRET:bridge}]])for(const [name,text]of Object.entries(secrets))await api(`/workers/scripts/${worker}/secrets`,'PUT',{name,text,type:'secret_text'});
 }
 report.deployments={};
 for(const worker of [r.authWorker,r.factoryWorker]){
  const settings=await api(`/workers/scripts/${worker}/settings`);const dbs=(settings.bindings||[]).filter(x=>x.type==='d1');
  if(dbs.length!==2||!dbs.some(x=>x.name==='ACCOUNT_DB'&&x.id===r.accountDbId)||!dbs.some(x=>x.name==='PLATFORM_DB'&&x.id===r.platformDbId))throw Error('deployed_binding_mismatch');
  const unexpected=(settings.bindings||[]).filter(x=>!['d1','plain_text','secret_text','durable_object_namespace'].includes(x.type));if(unexpected.length)throw Error('unexpected_bindings');
  report.deployments[worker]=await api(`/workers/scripts/${worker}/deployments`);
 }
 for(const origin of [r.authOrigin,r.factoryOrigin]){let ready=false;for(let attempt=0;attempt<12;attempt++){try{const response=await fetch(`${origin}/health`,{signal:AbortSignal.timeout(15000),redirect:'error'});if(response.ok){ready=true;break;}}catch{}await new Promise(ok=>setTimeout(ok,5000));}if(!ready)throw Error('cloud_health_failed');}
 report.wasmSha256=createHash('sha256').update(readFileSync('core/deploy/platform-worker/build/worker/index.wasm')).digest('hex');
 report.status='PASS'; console.log('Cloud test workers deployed; bindings verified; authentication acceptance still required.');
}catch(error){console.error(error.message?.startsWith('cloud_api_failed:')?error.message:'cloud_deployment_failed');process.exitCode=1;}
finally{writeFileSync('evidence/cloud-deployment.json',JSON.stringify(report,null,2));}
