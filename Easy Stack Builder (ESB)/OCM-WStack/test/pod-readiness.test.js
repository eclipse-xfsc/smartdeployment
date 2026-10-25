'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{evaluate}=require('../lib/pod-readiness');
const namespaces=['security','ocm-wstack','observability'];
const ready=()=>({metadata:{name:'service-pod',namespace:'ocm-wstack'},status:{phase:'Running',containerStatuses:[{ready:true}]}});
const job=()=>({metadata:{name:'openbao-bootstrap',namespace:'security',uid:'current-job'},status:{conditions:[{type:'Complete',status:'True'}]}});
const attempt=()=>({metadata:{name:'failed-attempt',namespace:'security',ownerReferences:[{kind:'Job',uid:'current-job',controller:true}]},status:{phase:'Failed'}});
const probe=()=>({metadata:{name:'openbao-bootstrap-debug-1792263454',namespace:'security',labels:{'app.kubernetes.io/name':'openbao-bootstrap','app.kubernetes.io/instance':'openbao','app.kubernetes.io/component':'openbao-bootstrap'}},spec:{serviceAccountName:'openbao-bootstrap',restartPolicy:'Never',containers:[{name:'bootstrap'}]},status:{phase:'Failed'}});
test('retained failed attempts are reported without blocking after the exact owning Job completes',()=>{
 const r=evaluate([ready(),attempt()],[job()],namespaces);assert.equal(r.ready,true);
 assert.deepEqual(r.ignored,[{namespace:'security',name:'failed-attempt',reason:'failed-attempt-of-completed-job'}]);
});
test('failed Jobs and failed attempts of unfinished Jobs block, including a failed Job whose pod was removed',()=>{
 const j=job();j.status.conditions=[{type:'Failed',status:'True'}];assert.equal(evaluate([ready()],[j],namespaces).ready,false);
 assert.deepEqual(evaluate([ready()],[j],namespaces).failedJobs,[{namespace:'security',name:'openbao-bootstrap'}]);
 j.status.conditions=[];assert.equal(evaluate([ready(),attempt()],[j],namespaces).ready,false);
 j.status.conditions=[{type:'Complete',status:'True'},{type:'Failed',status:'True'}];assert.equal(evaluate([ready(),attempt()],[j],namespaces).ready,false);
});
test('completed Job names cannot hide failed pods with foreign ownership or namespaces',()=>{
 for(const change of [j=>j.metadata.uid='other-job',j=>j.metadata.namespace='observability',j=>j.status.conditions[0].status='False']){
  const j=job();change(j);assert.equal(evaluate([ready(),attempt()],[j],namespaces).ready,false);
 }
 const p=attempt();p.metadata.ownerReferences[0].controller=false;assert.equal(evaluate([ready(),p],[job()],namespaces).ready,false);
});
test('only the terminal standalone OpenBao diagnostic shape is excluded, and is still reported',()=>{
 const r=evaluate([ready(),probe()],[],namespaces);assert.equal(r.ready,true);assert.equal(r.ignored[0].reason,'terminal-openbao-diagnostic');
 for(const change of [p=>p.metadata.name='openbao-0',p=>p.metadata.namespace='observability',p=>delete p.metadata.labels['app.kubernetes.io/component'],p=>p.metadata.ownerReferences=[{kind:'ReplicaSet',uid:'deployment',controller:true}],p=>p.spec.serviceAccountName='other',p=>p.spec.restartPolicy='Always',p=>p.status.phase='Pending']){
  const p=probe();change(p);assert.equal(evaluate([ready(),p],[],namespaces).ready,false);
 }
});
test('failed live workloads, non-ready running containers and missing OCM workloads still block',()=>{
 const p=ready();p.status.phase='Failed';assert.equal(evaluate([p],[],namespaces).ready,false);
 p.status.phase='Running';p.status.containerStatuses[0].ready=false;assert.equal(evaluate([p],[],namespaces).ready,false);
 assert.equal(evaluate([probe()],[],namespaces).ready,false);
 const succeeded={metadata:{name:'completed-job-pod',namespace:'security'},status:{phase:'Succeeded'}};
 assert.equal(evaluate([ready(),succeeded],[],namespaces).ready,true);
});
