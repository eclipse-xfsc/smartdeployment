'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const startup=require('../lib/ocm-startup'),ocm=require('../lib/ocm');
function deployment(image=startup.IMAGE){return {metadata:{name:'credential-retrieval-service',generation:1,resourceVersion:'1'},spec:{replicas:1,strategy:{type:'Recreate'},template:{spec:{containers:[{name:'credential-retrieval-service',image,env:[
 {name:'CREDENTIALRETRIEVAL_CASSANDRA_HOSTS',value:'cassandra.infrastructure.svc.cluster.local'},
 {name:'CREDENTIALRETRIEVAL_MIGRATIONS_TABLE',value:'retrieval_schema_migration'},
 ...['USER','PASSWORD'].map((part,i)=>({name:'CREDENTIALRETRIEVAL_CASSANDRA_'+part,valueFrom:{secretKeyRef:{name:'credential-retrieval-cassandra-credentials',key:i?'password':'username'}}}))
]}]}}},status:{availableReplicas:0}};}
function pod(image=startup.IMAGE){return {metadata:{name:'credential-retrieval-service-test',labels:{'app.kubernetes.io/name':'credential-retrieval-service'}},spec:{containers:[{name:'credential-retrieval-service',image}]},status:{containerStatuses:[{name:'credential-retrieval-service',imageID:'docker-pullable://repo@'+startup.RECOVERY_IMAGES[image],ready:false,restartCount:9,state:{waiting:{reason:'CrashLoopBackOff'}},lastState:{terminated:{exitCode:1}}}]}};}
test('all three resolver clients use the Service actually present in the supplied cluster',()=>{
 const values=ocm.overrides({tenantUrl:'https://test.example.com',tenantId:'test'});
 assert.equal(values[ocm.POLICY].policy.addresses.didResolver,startup.RESOLVER);
 assert.equal(values[ocm.VERIFICATION]['credential-verification-service'].config.didResolver,startup.RESOLVER);
 assert.equal(values[ocm.DIDCOMM]['didcomm-connector'].config.didcomm.resolverUrl,startup.RESOLVER);
 const docs={service:{kind:'Service',metadata:{name:'universal-resolver-service'},spec:{ports:[{port:8080,targetPort:'http'}],selector:{app:'resolver'}}},deployment:{kind:'Deployment',spec:{template:{metadata:{labels:{app:'resolver'}},spec:{containers:[{ports:[{name:'http',containerPort:8080}]}]}}}}};
 ocm.validateManifests(docs,ocm.RESOLVER_CHART);docs.service.metadata.name='universal-resolver';assert.throws(()=>ocm.validateManifests(docs,ocm.RESOLVER_CHART),{code:'RESOLVER_SERVICE'});
});
test('recovery refuses unknown image or scope and waits for any running native migration',()=>{
 const d=deployment(),p=pod();assert.deepEqual(startup.recoveryContract(d,[p]),{secret:'credential-retrieval-cassandra-credentials',image:startup.IMAGE,digest:startup.DIGEST});
 p.status.containerStatuses[0].state={running:{}};assert.equal(startup.recoveryContract(d,[p]),null);
 p.status.containerStatuses[0].state={waiting:{}};p.status.containerStatuses[0].imageID='repo@sha256:unknown';assert.throws(()=>startup.recoveryContract(d,[p]),{code:'RETRIEVAL_RECOVERY_IMAGE'});
 d.spec.template.spec.containers[0].image='other:1';assert.throws(()=>startup.recoveryContract(d,[pod()]),{code:'RETRIEVAL_RECOVERY_CONTRACT'});
 const scoped=deployment();scoped.spec.template.spec.containers[0].env[0].value='external-db';assert.throws(()=>startup.recoveryContract(scoped,[pod()]),{code:'RETRIEVAL_RECOVERY_CONTRACT'});
});
test('the observed 1.1.7-alpha image is recoverable only at its reported digest, without admitting other images',()=>{
 for(const [image,digest] of Object.entries(startup.RECOVERY_IMAGES)){
  const d=deployment(image),p=pod(image);assert.deepEqual(startup.recoveryContract(d,[p]),{secret:'credential-retrieval-cassandra-credentials',image,digest});
  p.status.containerStatuses[0].imageID='repo@sha256:'+'0'.repeat(64);assert.throws(()=>startup.recoveryContract(d,[p]),{code:'RETRIEVAL_RECOVERY_IMAGE'});
 }
 const alpha=Object.keys(startup.RECOVERY_IMAGES).find(image=>image.endsWith(':1.1.7-alpha')),p=pod(alpha);
 p.status.containerStatuses[0].imageID='repo@'+startup.DIGEST;assert.throws(()=>startup.recoveryContract(deployment(alpha),[p]),{code:'RETRIEVAL_RECOVERY_IMAGE'});
 const unknown=deployment('unreviewed:1');assert.throws(()=>startup.recoveryContract(unknown,[pod()]),{code:'RETRIEVAL_RECOVERY_CONTRACT'});
});
test('the independently retrieved native V001 Git blob is retained unchanged',()=>{
 const bytes=fs.readFileSync(path.join(__dirname,'../scripts/retrieval-v001.cql')),crypto=require('node:crypto');
 assert.equal(crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),'eae12c28d9b702471198e9fd6bba125bc0d3c07b');
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),startup.CHECKSUM);
});
test('alpha recovery waits for any native process or an available replica and never repairs a non-crash state',()=>{
 const image=Object.keys(startup.RECOVERY_IMAGES).find(image=>image.endsWith(':1.1.7-alpha'));
 for(const change of [p=>p.status.containerStatuses[0].state={running:{}},p=>p.status.containerStatuses[0].ready=true,p=>p.metadata.deletionTimestamp='now',p=>p.status.containerStatuses[0].lastState.terminated.exitCode=0,p=>delete p.status.containerStatuses[0].imageID]){
  const p=pod(image);change(p);assert.equal(startup.recoveryContract(deployment(image),[p]),null);
 }
 const d=deployment(image);d.status.availableReplicas=1;assert.equal(startup.recoveryContract(d,[pod(image)]),null);
});
function recoveryRunner(d,p,{change=()=>{}}={}){
 const operations=[],records=[],before={version:1,dirty:true,checksum:startup.CHECKSUM};
 const r={secrets:[],emit:e=>operations.push(e.type),json:async(cmd,args)=>{
  if(args.includes('secret'))return {data:{username:Buffer.from('native-user').toString('base64'),password:Buffer.from('private-password').toString('base64')}};
  if(args.includes('configmap'))return null;
  if(args.includes('deployment')){change(d,p);return d;}
  if(args.includes('infrastructure'))return {items:[{metadata:{name:'cassandra-0'},status:{containerStatuses:[{name:'cassandra',ready:true}]}}]};
  return {items:[p]};
 },run:async(cmd,args,options)=>{
  assert.ok(!args.join(' ').includes('private-password'));
  if(args.includes('exec')){const c=JSON.parse(options.input);operations.push(c.mode);assert.equal(c.checksum,startup.CHECKSUM);if(c.mode==='repair')assert.deepEqual(c.expected,before);return {code:0,stdout:JSON.stringify(c.mode==='inspect'?{state:'repairable',before,schema:null}:{state:'repaired',before,after:{dirty:false}})};}
  operations.push('evidence');records.push(JSON.parse(JSON.parse(options.input).data['recovery.json']));return {code:0,stdout:''};
 }};return {r,operations,records};
}
test('alpha recovery records its actual image and digest before and after the conditional native repair',async()=>{
 const image=Object.keys(startup.RECOVERY_IMAGES).find(image=>image.endsWith(':1.1.7-alpha')),f=recoveryRunner(deployment(image),pod(image));
 assert.equal((await startup.repair(f.r,deployment(image),[pod(image)])).state,'repaired');
 assert.deepEqual(f.operations,['inspect','evidence','repair','evidence','migration-recovery']);
 assert.equal(f.records.length,2);for(const record of f.records){assert.equal(record.image,image);assert.equal(record.digest,startup.RECOVERY_IMAGES[image]);assert.ok(!JSON.stringify(record).includes('private-password'));}
});
test('a Retrieval readiness change during inspection skips database repair without a fatal startup error',async()=>{
 const image=Object.keys(startup.RECOVERY_IMAGES).find(image=>image.endsWith(':1.1.7-alpha')),d=deployment(image),p=pod(image),f=recoveryRunner(d,p,{change:d=>d.status.availableReplicas=1});
 assert.equal((await startup.repair(f.r,d,[p])).state,'settling');assert.deepEqual(f.operations,['inspect','evidence']);
});
test('image or native credential reference changes after inspection block the database write',async()=>{
 const alpha=Object.keys(startup.RECOVERY_IMAGES).find(image=>image.endsWith(':1.1.7-alpha'));
 for(const change of [(d,p)=>{d.spec.template.spec.containers[0].image=alpha;p.spec.containers[0].image=alpha;p.status.containerStatuses[0].imageID='repo@'+startup.RECOVERY_IMAGES[alpha];},d=>{for(const e of d.spec.template.spec.containers[0].env)if(e.valueFrom)e.valueFrom.secretKeyRef.name='other-native-secret';}]){
  const d=deployment(),p=pod(),f=recoveryRunner(d,p,{change});await assert.rejects(startup.repair(f.r,d,[p]),{code:'RETRIEVAL_RECOVERY_CONTRACT'});assert.deepEqual(f.operations,['inspect','evidence']);
 }
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
 const r={emit(){},json:async()=>({items:[d]}),run:async(cmd,a)=>{if(a.includes('--raw'))return {code:0,stdout:JSON.stringify({ready:true,credentials:{synchronized:true},redis:{authenticated:true},services:Object.entries(require('../lib/ocm-guard-core').SUBJECTS).map(([name,subjects])=>({name,subjects,ready:true})),checkedAt:new Date().toISOString()})};assert.equal(JSON.parse(a.at(-1))[1].value.type,'Recreate');writes++;d.spec.strategy={type:'Recreate'};d.status={observedGeneration:1,replicas:1,updatedReplicas:1,availableReplicas:1,readyReplicas:1};}};
 await startup.stabilize(r,{timeoutSeconds:10,runtimeEnabled:false},{now:()=>clock,sleep:async n=>{clock+=n;},guardStatus:async()=>({ready:true})});assert.equal(writes,1);
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
