'use strict';
const {transportFailure,delay}=require('./api-recovery');
const {fail}=require('./config');
const {identity}=require('./kube-client');
const {review}=require('./kube-access');
const MAX_FORBIDDEN_RETRIES=3;
async function read(r,endpoint,{established=false,timeoutSeconds=120,sleep=delay,now=Date.now}={}) {
  if(endpoint!=='/api/v1/namespaces/argocd/pods'&&!/^\/apis\/(?:argoproj\.io\/v1alpha1\/namespaces\/[a-z0-9-]+\/(?:applications|applicationsets)|apiextensions\.k8s\.io\/v1\/customresourcedefinitions\/(?:applications|applicationsets|appprojects)\.argoproj\.io)$/.test(endpoint||''))fail('API_READ_PATH','Unsupported Argo readiness API path.');
  if(!Number.isFinite(timeoutSeconds)||timeoutSeconds<=0)fail('API_READ_TIMEOUT','Read timeout must be positive.');
  const deadline=now()+timeoutSeconds*1000;let attempt=0,last='',forbiddenResponses=0;
  const budget=max=>{
    const remaining=deadline-now();
    if(remaining<=0)fail('ARGO_API_UNAVAILABLE',`Argo API readiness exhausted its ${timeoutSeconds}s read budget for ${endpoint}. Resources retained. Last result: ${last}`);
    return Math.min(max,remaining);
  };
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
        if(forbiddenResponses)r.emit({type:'api-read-recovered',endpoint,forbiddenResponses});
        return doc;
      }
    } catch(e) {
      const message=e.commandOutput||e.message;
      if(r.signal?.aborted)throw e;
      last=r.redact(message).slice(-1200);
      if(/unauthorized|x509:/i.test(message))throw e;
      if(/forbidden/i.test(message)) {
        const match=/^\/apis\/argoproj\.io\/v1alpha1\/namespaces\/([a-z0-9-]+)\/(applications|applicationsets)$/.exec(endpoint);
        // Recover only these list reads. A review is not proof of read success;
        // retry the actual request with the same binding and a small fixed limit.
        if(!match)throw e;
        const expected=r.env?.ESB_KUBE_USERNAME;
        if(!expected)fail('KUBE_IDENTITY','Cannot recheck a denied read without the expected uploaded-kubeconfig identity. Resources retained.');
        const actual=await identity(r,{timeout:budget(15000)});
        if(actual.username!==expected)fail('KUBE_IDENTITY_CHANGED',`Read recheck authenticated as ${actual.username}, expected uploaded identity ${expected}. Resources retained.`);
        await review(r,{group:'argoproj.io',version:'v1alpha1',resource:match[2],verb:'list',namespace:match[1]},
          {phase:'argo-read-recheck',username:actual.username,timeout:budget(20000)});
        if(++forbiddenResponses>MAX_FORBIDDEN_RETRIES)fail('ARGO_ACCESS_INCONSISTENT',`Argo list read ${endpoint} returned Forbidden ${forbiddenResponses} times for ${expected} while its authorization reviews allowed access. Check API authorization/audit logs. Resources retained; ESB did not change credentials or permissions.`);
      } else if(!transportFailure(e)&&e.code!=='TIMEOUT'&&!/\bNotFound\b|the server could not find the requested resource|couldn't get current server API group list: unknown|the server doesn't have a resource type|an error on the server \("unknown"\)/i.test(message))throw e;
    }
    r.emit({type:'api-read-retry',endpoint,attempt:++attempt,reason:last});
    const after=deadline-now();if(after<=0)break;
    await sleep(Math.min(5000,after),r.signal);
  }
  fail('ARGO_API_UNAVAILABLE',`Argo API readiness did not succeed within ${timeoutSeconds}s for ${endpoint}. Resources retained. Last result: ${last}`);
}
module.exports={read,MAX_FORBIDDEN_RETRIES};
