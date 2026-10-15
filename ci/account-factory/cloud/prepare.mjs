// Configuration generation is executable work and therefore Actions-only.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { requireIsolation } from '../factory-core.mjs';
if(process.env.GITHUB_ACTIONS!=='true' || !process.env.RUNNER_TEMP) throw Error('actions_only');
const resources=JSON.parse(readFileSync(new URL('./resources.json',import.meta.url)));
requireIsolation(resources);
const dir=join(process.env.RUNNER_TEMP,'cloud-accounts'); mkdirSync(dir,{recursive:true,mode:0o700});
const databases=[{binding:'ACCOUNT_DB',database_name:'fabushi-ci-isolated-accounts',database_id:resources.accountDbId},{binding:'PLATFORM_DB',database_name:'fabushi-ci-isolated-platform',database_id:resources.platformDbId}];
const common={compatibility_date:'2026-07-18',compatibility_flags:['global_fetch_strictly_public'],workers_dev:true,account_id:resources.accountId,keep_vars:true,observability:{enabled:false},d1_databases:databases};
const policy={audience:resources.factoryOrigin,repository:'bhrumom/fabushi-backend',repositoryId:'1375313125',ownerId:'281146136',workflowRefs:['bhrumom/fabushi-backend/.github/workflows/ci-account-factory-cloud.yml@refs/heads/main','bhrumom/fabushi-backend/.github/workflows/ci-account-factory-cancel.yml@refs/heads/main'],refs:['refs/heads/main']};
const factory={...common,name:resources.factoryWorker,main:resolve('ci/account-factory/cloud/worker.mjs'),compatibility_flags:['nodejs_compat','global_fetch_strictly_public'],vars:{ENVIRONMENT:'ci-isolated',ISOLATION_CONFIG:JSON.stringify(resources),OIDC_POLICY:JSON.stringify(policy),BACKEND_SHA:process.env.GITHUB_SHA,CORE_SHA:process.env.CORE_SHA},durable_objects:{bindings:[{name:'LEASE_OWNER',class_name:'AccountLeaseOwner'}]},migrations:[{tag:'v1',new_sqlite_classes:['AccountLeaseOwner']}],triggers:{crons:['* * * * *']}};
const auth={...common,name:resources.authWorker,main:resolve('core/deploy/platform-worker/build/worker/shim.mjs'),vars:{ACCESS_TOKEN_KEY_ID:'ci-isolated-v1',AUTH_PUBLIC_BASE_URL:resources.authOrigin,AUTH_REGISTRATION_BRIDGE_URL:resources.factoryOrigin}};
writeFileSync(join(dir,'factory.json'),JSON.stringify(factory)); writeFileSync(join(dir,'auth.json'),JSON.stringify(auth));
