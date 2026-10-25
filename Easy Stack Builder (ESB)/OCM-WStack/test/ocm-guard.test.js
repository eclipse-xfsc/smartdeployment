'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const core=require('../lib/ocm-guard-core'),guard=require('../lib/ocm-guard'),ocm=require('../lib/ocm');
const b64=s=>Buffer.from(s).toString('base64'),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(){
 const secret={metadata:{name:'bridge-redis-credentials'},data:{username:b64('bridge'),password:b64('first-private-password')}};
 const e=[{name:'PREAUTHBRIDGE_REDIS_HOSTS',value:'redis.infrastructure.svc.cluster.local:6379'},...['username','password'].map(key=>({name:'PREAUTHBRIDGE_REDIS_'+key.toUpperCase(),valueFrom:{secretKeyRef:{name:secret.metadata.name,key}}}))];
 const deployment=name=>({metadata:{name,uid:name,generation:1,resourceVersion:'7'},spec:{replicas:1,template:{metadata:{annotations:{}},spec:{containers:[{name,image:'native:reviewed',env:name===core.BRIDGE?e:name===core.VERIFICATION?Object.entries(core.VERIFICATION_NATS_ENV).map(([name,value])=>({name,value})):[{name:'WELLKNOWN_SERVICE_NATS_URL',value:'nats://nats.infrastructure.svc.cluster.local:4222'}]}]}}},status:{observedGeneration:1,replicas:1,updatedReplicas:1,readyReplicas:1,availableReplicas:1}});
 const bridge=deployment(core.BRIDGE),wk=deployment(core.WELLKNOWN),secrets=new Map([[secret.metadata.name,secret]]);
 bridge.spec.template.metadata.annotations[core.ANNOTATION]=core.credentialDigest(bridge,secrets);
 const deployments=[bridge,wk,deployment(core.VERIFICATION)];
 const replicasets=deployments.map(d=>({metadata:{uid:d.metadata.name+'-rs',ownerReferences:[{uid:d.metadata.uid,controller:true}]}}));
 const pods=deployments.map((d,i)=>({metadata:{name:d.metadata.name+'-pod',uid:d.metadata.name+'-pod-uid',annotations:{...d.spec.template.metadata.annotations},ownerReferences:[{uid:d.metadata.name+'-rs',controller:true}]},spec:d.spec.template.spec,status:{phase:'Running',podIP:'10.0.0.'+(i+1)}}));
 const claims=[{metadata:{name:'bridge-redis'},spec:{type:'redis',providerRef:{name:'redis'},externalSecretRef:{name:secret.metadata.name},parameters:{acl:{keys:['auth:*']},database:0}},status:{phase:'Pending'}}];
 const externalSecrets=[{metadata:{name:secret.metadata.name},spec:{target:{name:secret.metadata.name}}}];
 const provider={metadata:{name:'redis'},spec:{adminSecretRef:{namespace:'infrastructure',name:'redis-root-auth'},outputs:{env:{REDIS_HOSTS:'redis.infrastructure.svc.cluster.local:6379',REDIS_ISCLUSTER:'false',REDIS_TLS:'false'}}}};
 const admin={data:{password:b64('admin-private-password')}};
 const connections=pods.map((p,i)=>({ip:p.status.podIP,subscriptions_list:core.SUBJECTS[deployments[i].metadata.name]}));
 const writes=[],commands=[];let natsFailure=false;
 const api={list:async kind=>({deployments,secrets:[...secrets.values()],resourceclaims:claims,externalsecrets:externalSecrets,pods,replicasets}[kind]),get:async kind=>kind==='resourceproviders'?provider:admin,connections:async()=>connections,natsAvailable:async()=>{if(natsFailure)core.blocked('NATS_UNAVAILABLE');},annotate:async(d,a)=>writes.push({name:d.metadata.name,annotations:a})};
 const connect=async(endpoint,auth)=>({close(){},command:async(...args)=>{commands.push(args);if(args[0]==='PING')return 'PONG';if(args[1]==='GETUSER')return ['flags',['on'],'passwords',[sha(Buffer.from(secret.data.password,'base64').toString())],'keys','~auth:*','commands','+@all','selectors',[]];return 'OK';}});
 return {secret,secrets,bridge,wk,deployments,claims,externalSecrets,provider,admin,connections,pods,replicasets,api,connect,writes,commands,setNatsFailure:()=>{natsFailure=true;}};
}
test('a pending ResourceClaim is recoverable through its actual ESO target without adopting the Redis default user',()=>{
 const f=fixture();const c=core.redisContract(f.bridge,f.claims,f.provider,f.secrets,f.admin,f.externalSecrets);assert.equal(c.username,'bridge');assert.equal(c.database,0);
 f.secret.data.username=b64('default');assert.throws(()=>core.redisContract(f.bridge,f.claims,f.provider,f.secrets,f.admin,f.externalSecrets),{code:'REDIS_ACCOUNT_CONTRACT'});
 f.secret.data.username=b64('bridge');f.claims[0].spec.parameters.acl.keys=['*'];assert.throws(()=>core.redisContract(f.bridge,f.claims,f.provider,f.secrets,f.admin,f.externalSecrets),{code:'REDIS_ACL_CONTRACT'});
});
test('a REST-ready pair requires every current-pod subscription and Redis authentication',async()=>{
 const f=fixture();assert.equal((await core.reconcile(f.api,{connect:f.connect})).ready,true);assert.equal(f.writes.length,0);
 f.connections[0].subscriptions_list=['auth.authorization.generate'];const d=await core.reconcile(f.api,{connect:f.connect});assert.equal(d.ready,false);assert.equal(d.services[0].ready,false);assert.equal(f.writes.length,0);
});
test('obsolete, foreign, terminating and old-credential pods cannot satisfy listener checks',()=>{
 const f=fixture();assert.equal(core.listeners(f.bridge,f.pods,f.replicasets,f.connections).ready,true);
 for(const change of [p=>{p.metadata.ownerReferences[0].uid='foreign';},p=>{p.metadata.deletionTimestamp='now';},p=>{p.metadata.annotations[core.ANNOTATION]='stale';},p=>{p.status.podIP='10.0.0.99';}]){
  const pods=structuredClone(f.pods);change(pods[0]);assert.equal(core.listeners(f.bridge,pods,f.replicasets,f.connections).ready,false);
 }
 f.bridge.status.observedGeneration=0;assert.equal(core.listeners(f.bridge,f.pods,f.replicasets,f.connections).ready,false);
});
test('rotation verifies the selected Redis account before reload and preserves ESO Secret bytes',async()=>{
 const f=fixture(),original=structuredClone(f.secret);f.secret.data.password=b64('rotated-private-password');
 const d=await core.reconcile(f.api,{connect:f.connect});assert.equal(d.ready,false);assert.equal(f.writes.length,1);assert.equal(f.writes[0].name,core.BRIDGE);assert.equal(f.writes[0].annotations[core.ANNOTATION],core.credentialDigest(f.bridge,f.secrets));
 assert.deepEqual(f.secret,{...original,data:{...original.data,password:b64('rotated-private-password')}});assert.ok(f.commands.some(x=>x[0]==='PING'));
 // New pods load the new Secret and template checksum; the next pass is a no-op.
 Object.assign(f.bridge.spec.template.metadata.annotations,f.writes[0].annotations);Object.assign(f.pods[0].metadata.annotations,f.writes[0].annotations);f.writes.length=0;
 assert.equal((await core.reconcile(f.api,{connect:f.connect})).ready,true);assert.equal(f.writes.length,0);
});
test('failed Redis login prevents all credential reloads and completion',async()=>{
 const f=fixture();f.secret.data.password=b64('new');await assert.rejects(core.reconcile(f.api,{connect:async()=>{core.blocked('REDIS_CONNECTION');}}),{code:'REDIS_CONNECTION'});assert.equal(f.writes.length,0);
});
test('Well-Known startup recovery waits for reachable NATS, limits restarts and then requires subscriptions',async()=>{
 const f=fixture();f.connections[1].subscriptions_list=['wellknown.issuer.metadata'];const time=Date.parse('2026-10-11T16:00:00Z');
 f.setNatsFailure();await assert.rejects(core.reconcile(f.api,{connect:f.connect,now:()=>time}),{code:'NATS_UNAVAILABLE'});assert.equal(f.writes.length,0);
 f.api.natsAvailable=async()=>{};const first=await core.reconcile(f.api,{connect:f.connect,now:()=>time});assert.equal(first.ready,false);assert.deepEqual(f.writes,[{name:core.WELLKNOWN,annotations:{[core.RECOVERY]:new Date(time).toISOString()}}]);
 Object.assign(f.wk.spec.template.metadata.annotations,f.writes[0].annotations);f.writes.length=0;
 assert.equal((await core.reconcile(f.api,{connect:f.connect,now:()=>time+15000})).ready,false);assert.equal(f.writes.length,0);
 f.connections[1].subscriptions_list=core.SUBJECTS[core.WELLKNOWN];assert.equal((await core.reconcile(f.api,{connect:f.connect,now:()=>time+30000})).ready,true);
});
test('secret hashes track referenced keys, envFrom, volumes and init containers without metadata churn',()=>{
 const f=fixture(),d=f.bridge,first=core.credentialDigest(d,f.secrets);f.secret.metadata.resourceVersion='100';f.secret.data.unused='ZXh0cmE=';assert.equal(core.credentialDigest(d,f.secrets),first);
 d.spec.template.spec.initContainers=[{envFrom:[{secretRef:{name:f.secret.metadata.name}}]}];const all=core.credentialDigest(d,f.secrets);f.secret.data.unused='bmV3';assert.notEqual(core.credentialDigest(d,f.secrets),all);
 d.spec.template.spec.initContainers=[];d.spec.template.spec.volumes=[{projected:{sources:[{secret:{name:f.secret.metadata.name,items:[{key:'unused',path:'key'}]}}]}}];const volume=core.credentialDigest(d,f.secrets);f.secret.data.unused='b2xk';assert.notEqual(core.credentialDigest(d,f.secrets),volume);
 f.secret.data.password=undefined;assert.throws(()=>core.credentialDigest(d,f.secrets),{code:'CONSUMER_SECRET_KEY_PENDING'});
});
test('all consumers must finish their credential rollouts before completion',async()=>{
 const f=fixture();const consumer=structuredClone(f.wk);consumer.metadata.name='storage';consumer.status.readyReplicas=0;f.deployments.push(consumer);const d=await core.reconcile(f.api,{connect:f.connect});assert.equal(d.ready,false);assert.equal(d.credentials.pendingRollouts,1);
});
test('a Secret rotated during reconciliation invalidates the completion snapshot',async()=>{
 const f=fixture();let reads=0;const list=f.api.list;f.api.list=async kind=>{const rows=await list(kind);if(kind==='secrets'&&++reads===2){const newer=structuredClone(rows);newer[0].data.password=b64('late-rotation');return newer;}return rows;};
 const d=await core.reconcile(f.api,{connect:f.connect});assert.equal(d.ready,false);assert.equal(d.credentials.synchronized,false);
});
test('the initial Retrieval migration is allowed to finish before its first credential reload',async()=>{
 const f=fixture(),retrieval=structuredClone(f.bridge);retrieval.metadata.name='credential-retrieval-service';retrieval.spec.template.metadata.annotations={};retrieval.status.readyReplicas=0;f.deployments.push(retrieval);
 assert.equal((await core.reconcile(f.api,{connect:f.connect})).ready,false);assert.equal(f.writes.length,0);
 retrieval.status.readyReplicas=1;assert.equal((await core.reconcile(f.api,{connect:f.connect})).ready,false);assert.equal(f.writes[0].name,'credential-retrieval-service');
});
test('stale, incomplete and unauthenticated guard reports cannot mark deployment ready',async()=>{
 const f=fixture(),report=await core.reconcile(f.api,{connect:f.connect});
 const r={run:async()=>({code:0,stdout:JSON.stringify(report)}),json:async(cmd,args)=>({items:args.includes('deployments')?f.deployments:args.includes('pods')?f.pods:f.replicasets})};assert.equal((await guard.status(r)).ready,true);
 report.checkedAt=new Date(Date.now()-61000).toISOString();assert.equal((await guard.status(r)).ready,false);
 report.checkedAt=new Date().toISOString();report.redis.authenticated=false;assert.equal((await guard.status(r)).ready,false);
 report.redis.authenticated=true;report.services[1].subjects=[];assert.equal((await guard.status(r)).ready,false);
 report.services[1].subjects=core.SUBJECTS[core.WELLKNOWN];f.pods[1].metadata.uid='replacement-pod';assert.equal((await guard.status(r)).ready,false);
});
test('verification permits reordered NATS entries but blocks missing, duplicate, referenced or incorrect values',async()=>{
 const f=fixture(),d=f.deployments.find(d=>d.metadata.name===core.VERIFICATION),entries=d.spec.template.spec.containers[0].env;
 entries.reverse();assert.equal((await core.reconcile(f.api,{connect:f.connect})).ready,true);
 for(const [name,value] of Object.entries(core.VERIFICATION_NATS_ENV)){
  const item=entries.find(e=>e.name===name),old={...item};
  item.value='incorrect';assert.equal((await core.reconcile(f.api,{connect:f.connect})).code,'VERIFICATION_NATS_CONTRACT');
  item.value=value;item.valueFrom={secretKeyRef:{name:'some-secret',key:'value'}};assert.equal(core.verificationNatsContract(d),false);delete item.valueFrom;
  const index=entries.indexOf(item);entries.splice(index,1);assert.equal(core.verificationNatsContract(d),false);entries.splice(index,0,old);
  entries.push({...old});assert.equal(core.verificationNatsContract(d),false);entries.pop();
 }
 assert.equal((await core.reconcile(f.api,{connect:f.connect})).ready,true);
 f.deployments.splice(f.deployments.indexOf(d),1);assert.equal((await core.reconcile(f.api,{connect:f.connect})).ready,false);
});
test('verification checks actual current pods and rejects a ready report after its configuration changes',async()=>{
 const f=fixture(),report=await core.reconcile(f.api,{connect:f.connect});
 const r={run:async()=>({code:0,stdout:JSON.stringify(report)}),json:async(cmd,args)=>({items:args.includes('deployments')?f.deployments:args.includes('pods')?f.pods:f.replicasets})};
 assert.equal((await guard.status(r)).ready,true);
 const pod=f.pods.find(p=>p.spec.containers[0].name===core.VERIFICATION);pod.spec=structuredClone(pod.spec);
 pod.spec.containers[0].env[0].value='incorrect';assert.equal((await guard.status(r)).ready,false);
 assert.equal((await core.reconcile(f.api,{connect:f.connect})).code,'VERIFICATION_NATS_CONTRACT');
 pod.spec=structuredClone(f.deployments.find(d=>d.metadata.name===core.VERIFICATION).spec.template.spec);
 pod.metadata.annotations[core.ANNOTATION]='stale';assert.equal((await guard.status(r)).ready,false);delete pod.metadata.annotations[core.ANNOTATION];
 pod.spec.containers[0].image='obsolete:tag';assert.equal((await guard.status(r)).ready,false);
});
test('guard resources use namespace-scoped permissions, reuse the ORCE image and never retain uploaded kubeconfig',()=>{
 const docs=guard.resources('ecofacis/xfsc-orce:2.0.15',{'ocm-guard.js':'source','ocm-guard-core.js':'source'});const cluster=docs.find(x=>x.kind==='ClusterRole');assert.deepEqual(cluster.rules,[{apiGroups:['resources.xfsc.io'],resources:['resourceproviders'],resourceNames:['redis'],verbs:['get']}]);
 const deployment=docs.find(x=>x.kind==='Deployment');assert.equal(deployment.spec.template.spec.containers[0].image,'ecofacis/xfsc-orce:2.0.15');assert.ok(!JSON.stringify(docs).includes('KUBECONFIG'));assert.ok(!docs.some(x=>x.kind==='NetworkPolicy'&&x.metadata.namespace==='infrastructure'));
 assert.match(ocm.values({}).esbTemplatePatch,/esb.xfsc.io~1credentials/);assert.match(ocm.values({}).esbTemplatePatch,/esb.xfsc.io~1nats-recovery/);
});
test('foreign guard resources stop installation before any write',async()=>{
 let writes=0;await assert.rejects(guard.install({json:async()=>({metadata:{labels:{}}}),run:async()=>writes++,emit(){}},'ecofacis/xfsc-orce:2.0.15'),{code:'OWNERSHIP'});assert.equal(writes,0);
});
test('rendered bridge credentials and NATS monitoring are reviewed before cluster writes',()=>{
 const f=fixture();f.bridge.kind='Deployment';f.bridge.spec.template.metadata.annotations={'inject.xfsc.io/enabled':'true','inject.xfsc.io/env-prefix':'PREAUTHBRIDGE'};f.claims[0].kind='ResourceClaim';ocm.validateManifests({d:f.bridge,c:f.claims[0]},ocm.BRIDGE);
 f.claims[0].spec.parameters.acl.keys=['*'];assert.throws(()=>ocm.validateManifests({d:f.bridge,c:f.claims[0]},ocm.BRIDGE),{code:'OCM_VALUES'});
 assert.throws(()=>ocm.validateManifests({},ocm.NATS_CHART),{code:'NATS_MONITORING'});
});
test('real RESP exchange creates a missing account, replaces disabled/wrong credentials and authenticates a separate consumer connection',async t=>{
 let acl=null,authAttempts=0,sets=0;const sockets=new Set();
 const encode=x=>x===null?'$-1\r\n':Array.isArray(x)?'*'+x.length+'\r\n'+x.map(encode).join(''):'$'+Buffer.byteLength(String(x))+'\r\n'+x+'\r\n';
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0),authenticated=false;socket.on('data',data=>{buffer=Buffer.concat([buffer,data]);let parsed;while((parsed=core.parseResp(buffer))){buffer=buffer.subarray(parsed.next);const a=parsed.value;let response;
  if(a[0]==='AUTH'){authAttempts++;const [user,password]=a.length===3?a.slice(1):['default',a[1]];authenticated=user==='default'?password==='root':user==='bridge'&&acl?.on&&acl.password===sha(password);response=authenticated?'+OK\r\n':'-WRONGPASS hidden\r\n';}
  else if(!authenticated)response='-NOAUTH\r\n';
  else if(a[0]==='PING')response='+PONG\r\n';
  else if(a[1]==='GETUSER')response=encode(acl?['flags',[acl.on?'on':'off'],'passwords',[acl.password],'keys','~auth:*','commands','+@all','selectors',[]]:null);
  else if(a[1]==='SETUSER'){sets++;assert.deepEqual(a.slice(0,5),['ACL','SETUSER','bridge','reset','on']);assert.equal(a[6],'~auth:*');assert.equal(a[7],'+@all');acl={on:true,password:a[5].slice(1)};response='+OK\r\n';}else response='+OK\r\n';
  // Fragmented responses exercise buffering instead of an all-at-once stub.
  socket.write(response.slice(0,2));setImmediate(()=>socket.write(response.slice(2)));
 }});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{for(const s of sockets)s.destroy();server.close();});
 const c={endpoint:{host:'127.0.0.1',port:server.address().port},username:'bridge',password:'chosen-private-password',admin:{password:'root'},database:0};
 assert.deepEqual(await core.ensureRedis(c),{authenticated:true,changed:true});assert.equal(sets,1);assert.equal(authAttempts,2);
 assert.deepEqual(await core.ensureRedis(c),{authenticated:true,changed:false});assert.equal(sets,1);
 acl.on=false;assert.equal((await core.ensureRedis(c)).changed,true);
 c.password='rotated-private-password';assert.equal((await core.ensureRedis(c)).changed,true);
 await assert.rejects(core.redisConnection(c.endpoint,{username:'bridge',password:'chosen-private-password'}),e=>e.code==='REDIS_COMMAND'&&!e.message.includes('hidden'));
 assert.equal((await core.ensureRedis(c)).authenticated,true);
});
test('real NATS exchange requires PONG after CONNECT and carries the native URL credentials, without publishing',async t=>{
 const {natsPing}=require('../scripts/ocm-guard');let seen,denied=false;const sockets=new Set();
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('INFO {"auth_required":true}\r\n');let text='';socket.on('data',b=>{text+=b;let i;while((i=text.indexOf('\r\n'))>=0){const line=text.slice(0,i);text=text.slice(i+2);if(line.startsWith('CONNECT ')){seen=JSON.parse(line.slice(8));if(denied)socket.write('-ERR \'Authorization Violation secret-must-not-leak\'\r\n');}else if(line==='PING'){if(!denied)socket.write('PONG\r\n');}else assert.fail('Unexpected NATS operation: '+line);}});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{for(const s of sockets)s.destroy();server.close();});
 const options={dial:address=>{assert.deepEqual(address,{host:'nats.infrastructure.svc.cluster.local',port:4222});return net.connect({host:'127.0.0.1',port:server.address().port});}};
 await natsPing('nats://wellknown:private%40password@nats.infrastructure.svc.cluster.local:4222',{},options);assert.equal(seen.user,'wellknown');assert.equal(seen.pass,'private@password');
 denied=true;await assert.rejects(natsPing('nats://nats.infrastructure.svc.cluster.local:4222',{},options),e=>e.code==='NATS_UNAVAILABLE'&&!e.message.includes('secret-must-not-leak'));
 await assert.rejects(natsPing('nats://unexpected.example:4222',{},options),{code:'NATS_ENDPOINT_CONTRACT'});
});
test('monitoring HTTP errors and malformed JSON fail without exposing response contents',async t=>{
 const http=require('node:http'),{jsonRequest}=require('../scripts/ocm-guard');
 const server=http.createServer((req,res)=>{if(req.url==='/denied'){res.writeHead(403);res.end('private-response-must-not-leak');}else if(req.url==='/malformed')res.end('{private');else res.end(JSON.stringify({total:0,connections:[]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const url='http://127.0.0.1:'+server.address().port;
 assert.deepEqual(await jsonRequest(url),{total:0,connections:[]});
 await assert.rejects(jsonRequest(url+'/denied'),e=>e.code==='GUARD_HTTP'&&e.status===403&&!e.message.includes('private'));
 await assert.rejects(jsonRequest(url+'/malformed'),{code:'GUARD_JSON'});
});
