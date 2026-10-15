export function failureCategory(error) {
  const message=String(error?.message||'');
  for(const [pattern,label]of [[/redirect/i,'redirect_mode_failure'],[/fetch failed|Failed to fetch|Network connection/i,'fetch_transport_failure'],[/FOREIGN KEY constraint/i,'foreign_key_constraint'],[/no such (table|column)/i,'schema_missing'],[/transaction/i,'journal_transaction'],[/SQLITE/i,'sqlite_failure'],[/Too many subrequests/i,'subrequest_limit'],[/CPU time|1102/i,'worker_cpu_limit'],[/not implemented|not supported|unsupported|not a function|Illegal invocation/i,'runtime_unsupported']]) if(pattern.test(message))return label;
  const allowed=['not_configured','provision_failed','cleanup_failed','registration_not_completed','mail_not_delivered','invalid_auth_attempt','invalid_account_session','lease_already_allocated','quota_exceeded','oidc_denied'];
  return allowed.includes(message)?message:'unclassified_failure';
}
export function observedAuthFetch(capture,fetchImpl=fetch) {
  return async(url,options)=>{
    const path=new URL(url).pathname;
    const route=['/api/auth/browser/start','/api/auth/browser/register/code','/api/auth/browser/register','/api/auth/login'].includes(path)?path:/^\/api\/auth\/browser\/attempts\/[a-zA-Z0-9-]+$/.test(path)?'/api/auth/browser/attempts/:id':'unknown';
    try{
      const response=await fetchImpl(url,options);const diagnostic={route,status:response.status};
      if(!response.ok){const reader=response.clone().body?.getReader();let raw='';let bytes=0;
        if(reader)while(bytes<4096){const {done,value}=await reader.read();if(done)break;const part=value.subarray(0,4096-bytes);bytes+=part.byteLength;raw+=new TextDecoder().decode(part);if(bytes>=4096){reader.cancel().catch(()=>{});break;}}
        if(/Too many subrequests/i.test(raw))diagnostic.category='subrequest_limit';else if(/registration_email_unavailable/.test(raw))diagnostic.category='registration_email_unavailable';else if(/registration_email_failed/.test(raw))diagnostic.category='registration_email_failed';else if(/1102|CPU time|exceeded resource limits/i.test(raw))diagnostic.category='worker_resource_limit';else if(/memory|out of bounds|stack size/i.test(raw))diagnostic.category='worker_memory_limit';else if(/constraint|UNIQUE/i.test(raw))diagnostic.category='database_constraint';else if(/D1_ERROR|SQLITE|database/i.test(raw))diagnostic.category='database_failure';else if(/1042/.test(raw))diagnostic.category='worker_interop_blocked';else if(/1101/.test(raw))diagnostic.category='worker_exception';}
      capture(diagnostic);return response;
    }catch(error){capture({route,status:'transport_failed',category:failureCategory(error)});throw Error('auth_transport_failed');}
  };
}

export function safeFailureDetail(error,stage) {
 const names=['verifyActionsIdentity','AccountFactory.create','DurableJournal.reserve','DurableJournal.get','CloudJanitor.capture','CanonicalAuthAdapter.request','CanonicalAuthAdapter.register'];
 const stack=String(error?.stack||'').split('\n').slice(1);
 const frames=names.filter(name=>stack.some(line=>line.includes(`at ${name} (`)));
 const errorType=['Error','TypeError','SyntaxError','RangeError'].includes(error?.name)?error.name:'Error';
 return {stage:['authorization','oidc','body','allocate','cleanup'].includes(stage)?stage:'unknown',errorType,reason:failureCategory(error),frames};
}
