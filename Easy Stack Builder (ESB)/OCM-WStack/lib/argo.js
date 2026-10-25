'use strict';
const {read}=require('./kube-read');
const {delay}=require('./api-recovery');
const {fail}=require('./config');
function redisMirror(manifest) {
  // Only the Docker Official Redis repository is redirected. Preserve its tag.
  return manifest.replace(/(^[ \t]*image:[ \t]*)public\.ecr\.aws\/docker\/library\/redis(:[a-zA-Z0-9_.-]+)([ \t]*$)/gm,'$1docker.io/library/redis$2$3');
}
function unhealthy(doc) {
  return doc.items.filter(p=>!p.metadata?.deletionTimestamp&&p.status?.phase!=='Succeeded').filter(p=>p.status?.phase!=='Running'||!p.status?.containerStatuses?.length||!p.status.containerStatuses.every(c=>c.ready)).map(p=>({name:p.metadata?.name,phase:p.status?.phase||'Unknown',containers:(p.status?.containerStatuses||[]).filter(c=>!c.ready).map(c=>({name:c.name,reason:c.state?.waiting?.reason||c.state?.terminated?.reason||'NotReady',image:c.image})),initContainers:(p.status?.initContainerStatuses||[]).filter(c=>!c.ready&&c.state?.terminated?.exitCode!==0).map(c=>({name:c.name,reason:c.state?.waiting?.reason||c.state?.terminated?.reason||'NotReady',image:c.image}))}));
}
async function health(r,{timeoutSeconds=1800,diagnose=false,sleep=delay,now=Date.now}={}) {
  const deadline=now()+timeoutSeconds*1000;
  do {
    const doc=await read(r,'/api/v1/namespaces/argocd/pods',{timeoutSeconds:diagnose?10:Math.max(1,(deadline-now())/1000),sleep,now});
    const pending=unhealthy(doc);
    if(diagnose){r.emit({type:'argo-pods',pods:pending});return pending;}
    if(doc.items.some(p=>!p.metadata?.deletionTimestamp&&p.status?.phase==='Running')&&pending.length===0)return;
    r.emit({type:'argo-pods',pods:pending,empty:doc.items.length===0});
    const remaining=deadline-now();if(remaining<=0)break;
    await sleep(Math.min(5000,remaining),r.signal);
  } while(now()<deadline);
  fail('ARGO_PODS_UNREADY',`Argo pods did not become Ready within ${timeoutSeconds}s. See argo-pods diagnostics; resources retained.`);
}
module.exports={redisMirror,unhealthy,health};
