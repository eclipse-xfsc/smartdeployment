'use strict';
const condition=(job,type)=>job.status?.conditions?.some(x=>x.type===type&&x.status==='True');
function ignoredReason(pod,jobs){
 if(pod.status?.phase!=='Failed')return null;
 const owner=pod.metadata.ownerReferences?.find(x=>x.kind==='Job'&&x.controller===true&&x.uid);
 if(owner){
  const job=jobs.find(j=>j.metadata.namespace===pod.metadata.namespace&&j.metadata.uid===owner.uid);
  if(job&&condition(job,'Complete')&&!condition(job,'Failed'))return 'failed-attempt-of-completed-job';
 }
 const labels=pod.metadata.labels||{};
 if(!pod.metadata.ownerReferences?.length&&pod.metadata.namespace==='security'&&/^openbao-bootstrap-debug-[0-9]+$/.test(pod.metadata.name)&&
  labels['app.kubernetes.io/name']==='openbao-bootstrap'&&labels['app.kubernetes.io/instance']==='openbao'&&labels['app.kubernetes.io/component']==='openbao-bootstrap'&&
  pod.spec?.serviceAccountName==='openbao-bootstrap'&&pod.spec.restartPolicy==='Never'&&pod.spec.containers?.length===1&&pod.spec.containers[0].name==='bootstrap')return 'terminal-openbao-diagnostic';
 return null;
}
function evaluate(pods,jobs,namespaces){
 const managed=pods.filter(p=>namespaces.includes(p.metadata.namespace)&&!p.metadata.deletionTimestamp);
 const ignored=managed.flatMap(p=>{const reason=ignoredReason(p,jobs);return reason?[{namespace:p.metadata.namespace,name:p.metadata.name,reason}]:[];});
 const failedJobs=jobs.filter(j=>namespaces.includes(j.metadata.namespace)&&!j.metadata.deletionTimestamp&&condition(j,'Failed')).map(j=>({namespace:j.metadata.namespace,name:j.metadata.name}));
 const ready=failedJobs.length===0&&managed.some(p=>p.metadata.namespace==='ocm-wstack')&&managed.every(p=>ignoredReason(p,jobs)||p.status?.phase==='Succeeded'||
  (p.status?.phase==='Running'&&p.status?.containerStatuses?.length&&p.status.containerStatuses.every(c=>c.ready)));
 return {ready:Boolean(ready),ignored,failedJobs};
}
module.exports={ignoredReason,evaluate};
