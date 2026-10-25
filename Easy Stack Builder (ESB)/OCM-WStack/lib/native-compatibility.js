'use strict';
const path=require('node:path');
const {fail}=require('./config');
const POLICY='esb-ocm-cassandra-probes';
async function cassandra(r,timeoutSeconds){
 const existing=await r.json('kubectl',['get','clusterpolicy',POLICY,'--ignore-not-found','-o','json']);
 if(existing&&(existing.metadata?.annotations?.['meta.helm.sh/release-name']!=='esb-ocm-gateway'||existing.metadata?.annotations?.['meta.helm.sh/release-namespace']!=='security'))fail('OWNERSHIP','Cassandra probe policy belongs to another installation.');
 await r.run('kubectl',['apply','--field-manager=esb-ocmwstack','-f',path.join(__dirname,'../charts-gateway/templates/cassandra-probes.yaml')]);
 await r.run('kubectl',['wait','clusterpolicy/'+POLICY,'--for=condition=Ready',`--timeout=${timeoutSeconds}s`],{timeout:(timeoutSeconds+30)*1000});
 const d=await r.json('kubectl',['-n','infrastructure','get','statefulset','cassandra','--ignore-not-found','-o','json']);
 if(!d)return;
 const index=d.spec?.template?.spec?.containers?.findIndex(c=>c.name==='cassandra');
 const container=d.spec?.template?.spec?.containers?.[index];
 if(!container||!/(?:^|\/)library\/cassandra:/.test(container.image||''))fail('CASSANDRA_CONTRACT','Cassandra probe repair requires the official library/cassandra container.');
 const patches=[{op:'test',path:'/metadata/resourceVersion',value:d.metadata.resourceVersion}];
 for(const name of ['startupProbe','readinessProbe','livenessProbe']){
  const probe=container[name];
  if(JSON.stringify(probe?.exec?.command)!==JSON.stringify(['/bin/bash','-ec','nodetool statusbinary | grep -q running']))fail('CASSANDRA_CONTRACT','Cassandra probe command changed; automatic repair requires review.');
  const base=`/spec/template/spec/containers/${index}/${name}`;
  if(probe.timeoutSeconds!==10)patches.push({op:'add',path:base+'/timeoutSeconds',value:10});
  if(name==='livenessProbe'&&probe.failureThreshold!==6)patches.push({op:'add',path:base+'/failureThreshold',value:6});
 }
 if(patches.length>1){
  await r.run('kubectl',['-n','infrastructure','patch','statefulset','cassandra','--type=json','-p',JSON.stringify(patches)]);
  await r.run('kubectl',['-n','infrastructure','rollout','status','statefulset/cassandra',`--timeout=${timeoutSeconds}s`],{timeout:(timeoutSeconds+30)*1000});
 }
 r.emit({type:'cassandra-probes',updated:patches.length>1,timeoutSeconds:10,livenessFailureThreshold:6});
}
module.exports={cassandra,POLICY};
