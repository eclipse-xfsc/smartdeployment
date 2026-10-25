'use strict';
const {transportFailure,delay}=require('./api-recovery');
const {fail}=require('./config');
async function read(r,endpoint,{established=false,timeoutSeconds=120,sleep=delay,now=Date.now}={}) {
  if(!/^\/apis\/(?:argoproj\.io\/v1alpha1\/namespaces\/[a-z0-9-]+\/(?:applications|applicationsets)|apiextensions\.k8s\.io\/v1\/customresourcedefinitions\/(?:applications|applicationsets|appprojects)\.argoproj\.io)$/.test(endpoint||''))fail('API_READ_PATH','Unsupported Argo readiness API path.');
  if(!Number.isFinite(timeoutSeconds)||timeoutSeconds<=0)fail('API_READ_TIMEOUT','Read timeout must be positive.');
  const deadline=now()+timeoutSeconds*1000;let attempt=0,last='';
  while(now()<deadline) {
    const remaining=deadline-now();const seconds=Math.max(1,Math.min(10,Math.floor(remaining/1000)));
    try {
      const result=await r.run('kubectl',['get',`--raw=${endpoint}`,`--request-timeout=${seconds}s`],{timeout:remaining,processGroup:false});
      let doc;try {doc=JSON.parse(result.stdout);}catch {fail('API_READ_RESPONSE','Argo API returned invalid JSON.');}
      if(established) {
        if(doc.status?.conditions?.some(c=>c.type==='Established'&&c.status==='True'))return doc;
        last='Argo CRD is not Established';
      } else {
        if(!Array.isArray(doc.items))fail('API_READ_RESPONSE','Argo API did not return a resource list.');
        return doc;
      }
    } catch(e) {
      const message=e.commandOutput||e.message;
      if(r.signal?.aborted)throw e;
      if(/forbidden|unauthorized|x509:/i.test(message))throw e;
      if(!transportFailure(e)&&e.code!=='TIMEOUT'&&!/\bNotFound\b|the server could not find the requested resource|couldn't get current server API group list: unknown|the server doesn't have a resource type|an error on the server \("unknown"\)/i.test(message))throw e;
      last=r.redact(message).slice(-1200);
    }
    r.emit({type:'api-read-retry',endpoint,attempt:++attempt,reason:last});
    const after=deadline-now();if(after<=0)break;
    await sleep(Math.min(5000,after),r.signal);
  }
  fail('ARGO_API_UNAVAILABLE',`Argo API readiness did not succeed within ${timeoutSeconds}s for ${endpoint}. Resources retained. Last result: ${last}`);
}
module.exports={read};
