// Some runtimes differ in redirect:error handling. Always prevent the follow
// ourselves; never send credentials/JWKS verification through a redirect.
export function noRedirectFetch(fetchImpl=(...args)=>fetch(...args)) {
  return async(url,options={})=>{
    const response=await fetchImpl(url,{...options,redirect:'manual'});
    if(response.status>=300&&response.status<400)throw Error('unsafe_redirect');
    return response;
  };
}
