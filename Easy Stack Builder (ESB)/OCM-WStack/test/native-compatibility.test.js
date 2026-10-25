'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {cassandra}=require('../lib/native-compatibility'),ocm=require('../lib/ocm');
const command=['/bin/bash','-ec','nodetool statusbinary | grep -q running'];
function workload(){return {metadata:{resourceVersion:'123'},spec:{template:{spec:{containers:[{name:'sidecar',image:'unchanged'},{name:'cassandra',image:'docker.io/library/cassandra:5.0.5',...Object.fromEntries(['startupProbe','readinessProbe','livenessProbe'].map(n=>[n,{exec:{command},periodSeconds:n==='livenessProbe'?30:10}]))}]}}}};}
test('Cassandra repairs only probe timing by container name, preserves native commands and verifies rollout',async()=>{
 const d=workload(),calls=[];const r={json:async(cmd,args)=>args.includes('statefulset')?d:null,run:async(cmd,args)=>calls.push(args),emit(){}};
 await cassandra(r,600);const patch=JSON.parse(calls.find(a=>a.includes('patch')).at(-1));assert.equal(patch[0].value,'123');
 assert.equal(patch.length,5);assert.ok(patch.slice(1).every(x=>x.path.startsWith('/spec/template/spec/containers/1/')));
 assert.equal(patch.some(x=>x.path.includes('exec')),false);assert.equal(calls.some(a=>a.includes('rollout')),true);
 assert.ok(calls.findIndex(a=>a.includes('apply'))<calls.findIndex(a=>a.includes('patch')));
});
test('Cassandra repair is idempotent and refuses an unknown native command',async()=>{
 const d=workload();for(const p of ['startupProbe','readinessProbe','livenessProbe'])d.spec.template.spec.containers[1][p].timeoutSeconds=10;
 d.spec.template.spec.containers[1].livenessProbe.failureThreshold=6;
 const r={json:async(cmd,args)=>args.includes('statefulset')?d:null,run:async(cmd,args)=>assert.equal(args.includes('patch'),false),emit(){}};
 await cassandra(r,600);d.spec.template.spec.containers[1].startupProbe.exec.command=['different'];await assert.rejects(cassandra(r,600),{code:'CASSANDRA_CONTRACT'});
});
test('Verification creates a valid anonymous registry Secret and removes only invalid live list entries',async()=>{
 const calls=[],r={json:async(cmd,args)=>args.includes('deployment')?{metadata:{resourceVersion:'7'},spec:{template:{spec:{imagePullSecrets:[{}, {name:'existing-private-registry'}, {name:''}]}}}}:null,run:async(cmd,args,o)=>calls.push({args,o}),emit(){}};
 await ocm.verificationPullSecret(r);const secret=JSON.parse(calls[0].o.input);assert.equal(secret.type,'kubernetes.io/dockerconfigjson');assert.deepEqual(JSON.parse(secret.stringData['.dockerconfigjson']),{auths:{}});
 const patch=JSON.parse(calls[1].args.at(-1));assert.deepEqual(patch.slice(1).map(x=>x.path),['/spec/template/spec/imagePullSecrets/2','/spec/template/spec/imagePullSecrets/0']);
 assert.equal(ocm.overrides({})[ocm.VERIFICATION]['credential-verification-service'].image.pullSecrets,secret.metadata.name);
});
test('Verification retains operator-owned registry credentials and refuses ownership collision',async()=>{
 const r={json:async()=>({metadata:{labels:{}},type:'kubernetes.io/dockerconfigjson'}),run:async()=>assert.fail('No write allowed')};await assert.rejects(ocm.verificationPullSecret(r),{code:'OWNERSHIP'});
});
test('fresh storage bootstrap installs Cassandra protection before chart writes and main sync ignores only timing',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-native-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.cp(path.join(__dirname,'fixtures/upstream'),dir,{recursive:true});await require('../lib/adapt').adapt(dir);
 const s=await fs.readFile(path.join(dir,'basic-cluster-init.sh'),'utf8');const start=s.indexOf('node "${ESB_NATIVE_COMPAT');assert.ok(start>=0&&start<s.indexOf(' infrastructure storage '));
 assert.match(s,/ESB_STORAGE_VALUES/);const v=ocm.routingValues();assert.equal(v.tag,'main');assert.match(v.esbTemplatePatch,/name: cassandra/);assert.match(v.esbTemplatePatch,/\.livenessProbe.timeoutSeconds/);assert.doesNotMatch(v.esbTemplatePatch,/\.livenessProbe.exec/);
});
