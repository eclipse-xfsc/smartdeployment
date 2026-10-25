'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateWorkload}=require('../lib/grafana');
function workload(){return {kind:'Deployment',metadata:{name:'observability-grafana',labels:{'app.kubernetes.io/name':'grafana','app.kubernetes.io/instance':'observability'}},spec:{replicas:1,strategy:{type:'Recreate'},template:{spec:{securityContext:{runAsNonRoot:true,runAsUser:472,runAsGroup:472,fsGroup:472,fsGroupChangePolicy:'Always'},containers:[{name:'grafana',volumeMounts:[{name:'storage',mountPath:'/var/lib/grafana'}]}],volumes:[{name:'storage',persistentVolumeClaim:{claimName:'observability-grafana'}}]}}}};}
test('Grafana startup validation accepts the retained writable PVC without BusyBox chown',()=>{
 const doc=workload();assert.equal(validateWorkload({grafana:doc}),'observability-grafana');
 doc.kind='StatefulSet';delete doc.spec.strategy;assert.equal(validateWorkload({grafana:doc}),'observability-grafana');
});
test('persistent Grafana rejects the overlapping rollout and multiple replicas behind the reported Multi-Attach failure',()=>{
 const config=require('../lib/observability').values({actualStorageClass:'existing-storage',domain:'example.com'}).monitoring.grafana;
 assert.deepEqual(config.deploymentStrategy,{type:'Recreate',rollingUpdate:null});assert.equal(config.replicas,1);
 const doc=workload();doc.spec.strategy=config.deploymentStrategy;assert.equal(validateWorkload({grafana:doc}),'observability-grafana');
 for(const change of [d=>delete d.spec.strategy,d=>d.spec.strategy.type='RollingUpdate',d=>d.spec.strategy.rollingUpdate={maxSurge:1,maxUnavailable:0},d=>d.spec.replicas=2]){
  const d=workload();change(d);assert.throws(()=>validateWorkload({grafana:d}),{code:'GRAFANA_STARTUP'});
 }
 assert.deepEqual(config.persistence,{enabled:true,storageClassName:'existing-storage',size:'5Gi'});
});
test('Grafana startup validation rejects the reported failing init container and missing group permissions',()=>{
 for(const change of [doc=>doc.spec.template.spec.initContainers=[{name:'init-chown-data',image:'docker.io/library/busybox:1.38.0'}],doc=>delete doc.spec.template.spec.securityContext.fsGroup,doc=>doc.spec.template.spec.securityContext.runAsNonRoot=false,doc=>delete doc.spec.template.spec.securityContext.fsGroupChangePolicy]){
  const doc=workload();change(doc);assert.throws(()=>validateWorkload({grafana:doc}),{code:'GRAFANA_STARTUP'});
 }
});
test('Grafana startup validation rejects lost persistence, read-only data and ambiguous workload identity',()=>{
 for(const change of [doc=>delete doc.spec.template.spec.volumes[0].persistentVolumeClaim,doc=>doc.spec.template.spec.containers[0].volumeMounts[0].readOnly=true,doc=>doc.spec.template.spec.containers[0].volumeMounts[0].subPath='grafana',doc=>doc.metadata.labels['app.kubernetes.io/instance']='foreign']){
  const doc=workload();change(doc);assert.throws(()=>validateWorkload({grafana:doc}),{code:'GRAFANA_STARTUP'});
 }
 assert.throws(()=>validateWorkload({one:workload(),two:workload()}),{code:'GRAFANA_STARTUP'});
});
