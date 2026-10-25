'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateWorkload}=require('../lib/grafana');
function workload(){return {kind:'Deployment',metadata:{name:'observability-grafana',labels:{'app.kubernetes.io/name':'grafana','app.kubernetes.io/instance':'observability'}},spec:{template:{spec:{securityContext:{runAsNonRoot:true,runAsUser:472,runAsGroup:472,fsGroup:472,fsGroupChangePolicy:'Always'},containers:[{name:'grafana',volumeMounts:[{name:'storage',mountPath:'/var/lib/grafana'}]}],volumes:[{name:'storage',persistentVolumeClaim:{claimName:'observability-grafana'}}]}}}};}
test('Grafana startup validation accepts the retained writable PVC without BusyBox chown',()=>{
 const doc=workload();assert.equal(validateWorkload({grafana:doc}),'observability-grafana');
 doc.kind='StatefulSet';assert.equal(validateWorkload({grafana:doc}),'observability-grafana');
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
