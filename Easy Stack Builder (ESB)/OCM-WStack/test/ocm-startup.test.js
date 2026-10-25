'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const startup=require('../lib/ocm-startup'),ocm=require('../lib/ocm');
function deployment(){return {metadata:{name:'credential-retrieval-service',generation:1,resourceVersion:'1'},spec:{replicas:1,strategy:{type:'Recreate'},template:{spec:{containers:[{name:'credential-retrieval-service',image:startup.IMAGE,env:[
 {name:'CREDENTIALRETRIEVAL_CASSANDRA_HOSTS',value:'cassandra.infrastructure.svc.cluster.local'},
 {name:'CREDENTIALRETRIEVAL_MIGRATIONS_TABLE',value:'retrieval_schema_migration'},
 ...['USER','PASSWORD'].map((part,i)=>({name:'CREDENTIALRETRIEVAL_CASSANDRA_'+part,valueFrom:{secretKeyRef:{name:'credential-retrieval-cassandra-credentials',key:i?'password':'username'}}}))
]}]}}},status:{availableReplicas:0}};}
function pod(){return {metadata:{name:'credential-retrieval-service-test',labels:{'app.kubernetes.io/name':'credential-retrieval-service'}},spec:{containers:[{name:'credential-retrieval-service',image:startup.IMAGE}]},status:{containerStatuses:[{name:'credential-retrieval-service',imageID:'docker-pullable://repo@'+startup.DIGEST,ready:false,restartCount:9,state:{waiting:{reason:'CrashLoopBackOff'}},lastState:{terminated:{exitCode:1}}}]}};}
test('all three resolver clients use the Service actually present in the supplied cluster',()=>{
 const values=ocm.overrides({tenantUrl:'https://test.example.com',tenantId:'test'});
 assert.equal(values[ocm.POLICY].policy.addresses.didResolver,startup.RESOLVER);
 assert.equal(values[ocm.VERIFICATION]['credential-verification-service'].config.didResolver,startup.RESOLVER);
 assert.equal(values[ocm.DIDCOMM]['didcomm-connector'].config.didcomm.resolverUrl,startup.RESOLVER);
 const docs={service:{kind:'Service',metadata:{name:'universal-resolver-service'},spec:{ports:[{port:8080,targetPort:'http'}],selector:{app:'resolver'}}},deployment:{kind:'Deployment',spec:{template:{metadata:{labels:{app:'resolver'}},spec:{containers:[{ports:[{name:'http',containerPort:8080}]}]}}}}};
 ocm.validateManifests(docs,ocm.RESOLVER_CHART);docs.service.metadata.name='universal-resolver';assert.throws(()=>ocm.validateManifests(docs,ocm.RESOLVER_CHART),{code:'RESOLVER_SERVICE'});
});
test('recovery refuses unknown image or scope and waits for any running native migration',()=>{
 const d=deployment(),p=pod();assert.deepEqual(startup.recoveryContract(d,[p]),{secret:'credential-retrieval-cassandra-credentials'});
 p.status.containerStatuses[0].state={running:{}};assert.equal(startup.recoveryContract(d,[p]),null);
 p.status.containerStatuses[0].state={waiting:{}};p.status.containerStatuses[0].imageID='repo@sha256:unknown';assert.throws(()=>startup.recoveryContract(d,[p]),{code:'RETRIEVAL_RECOVERY_IMAGE'});
 d.spec.template.spec.containers[0].image='other:1';assert.throws(()=>startup.recoveryContract(d,[pod()]),{code:'RETRIEVAL_RECOVERY_CONTRACT'});
 const scoped=deployment();scoped.spec.template.spec.containers[0].env[0].value='external-db';assert.throws(()=>startup.recoveryContract(scoped,[pod()]),{code:'RETRIEVAL_RECOVERY_CONTRACT'});
});
test('repair records the original state before a conditional native repair and keeps credentials on stdin',async()=>{
 const d=deployment(),p=pod(),operations=[],before={version:1,dirty:true,checksum:startup.CHECKSUM};
 const r={secrets:[],emit:e=>operations.push(e.type),json:async(cmd,args)=>{
  if(args.includes('secret'))return {data:{username:Buffer.from('native-user').toString('base64'),password:Buffer.from('private-password').toString('base64')}};
  if(args.includes('configmap'))return null;
  if(args.includes('deployment'))return d;
  if(args.includes('infrastructure'))return {items:[{metadata:{name:'cassandra-0'},status:{containerStatuses:[{name:'cassandra',ready:true}]}}]};
  return {items:[p]};
 },run:async(cmd,args,options)=>{
  assert.ok(!args.join(' ').includes('private-password'));
  if(args.includes('exec')){const c=JSON.parse(options.input);assert.equal(c.username,'native-user');assert.equal(c.password,'private-password');operations.push(c.mode);if(c.mode==='repair')assert.deepEqual(c.expected,before);return {code:0,stdout:JSON.stringify(c.mode==='inspect'?{state:'repairable',before,schema:null}:{state:'repaired',before,after:{dirty:false}})};}
  operations.push('evidence');return {code:0,stdout:''};
 }};
 assert.equal((await startup.repair(r,d,[p])).state,'repaired');
 assert.deepEqual(operations,['inspect','evidence','repair','evidence','migration-recovery']);assert.ok(r.secrets.includes('private-password'));
});
test('a conflicting evidence owner blocks the database write',async()=>{
 const r={secrets:[],emit(){},json:async(cmd,a)=>a.includes('secret')?{data:{username:'dQ==',password:'cA=='}}:a.includes('configmap')?{metadata:{labels:{}}}:{items:[{metadata:{name:'cassandra-0'},status:{containerStatuses:[{name:'cassandra',ready:true}]}}]},run:async(cmd,a,o)=>{assert.equal(JSON.parse(o.input).mode,'inspect');return {code:0,stdout:JSON.stringify({state:'repairable',before:{}})};}};
 await assert.rejects(startup.repair(r,deployment(),[pod()]),{code:'OWNERSHIP'});
});
test('startup serializes an existing rollout, then requires current generation ready',async()=>{
 const d=deployment();d.spec.strategy={type:'RollingUpdate'};let clock=0,writes=0;
 const r={emit(){},json:async()=>({items:[d]}),run:async(cmd,a)=>{assert.equal(JSON.parse(a.at(-1))[1].value.type,'Recreate');writes++;d.spec.strategy={type:'Recreate'};d.status={observedGeneration:1,replicas:1,updatedReplicas:1,availableReplicas:1,readyReplicas:1};}};
 await startup.stabilize(r,{timeoutSeconds:10,runtimeEnabled:false},{now:()=>clock,sleep:async n=>{clock+=n;}});assert.equal(writes,1);
 d.metadata.generation=2;assert.equal(startup.ready(d),false);d.spec.replicas=0;assert.equal(startup.ready(d),false);
});
test('startup timeout retains resources and reports the failing services',async()=>{
 let clock=0;const r={emit(){},json:async()=>({items:[]}),run:async()=>{throw Error('unexpected write');}};
 await assert.rejects(startup.stabilize(r,{timeoutSeconds:20},{now:()=>clock,sleep:async n=>{clock+=n;}}),e=>e.code==='OCM_STARTUP'&&e.message.includes('didcomm-connector')&&e.message.includes('credential-retrieval-service'));
});
test('native migration replay safety checks execute in Python',()=>{
 const result=cp.spawnSync('python3',['-B',path.join(__dirname,'retrieval-recovery.py')],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
test('bootstrap invokes startup recovery before native ApplicationSet health wait',async t=>{
 const os=require('node:os');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ocm-startup-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.cpSync(path.join(__dirname,'fixtures/upstream'),dir,{recursive:true});await require('../lib/adapt').adapt(dir);
 const script=fs.readFileSync(path.join(dir,'ocm-wstack-init.sh'),'utf8');assert.match(script,/ESB_OCM_STARTUP[^\n]+\n\.\/check-applicationset.sh ocm-wstack argocd/);
 assert.match(ocm.values({}).esbTemplatePatch,/name: credential-retrieval-service\n\s+jsonPointers: \[\/spec\/strategy\]/);
});
