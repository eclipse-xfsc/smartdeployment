'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {config,resolve,fingerprint}=require('../lib/config');
const {waitTenantTls}=require('../lib/gateway-routing');
const repository=require('../upstream-lock.json').repository;
const host='demo-tenant.example.com';
const classes={items:[{metadata:{name:'default-csi',annotations:{'storageclass.kubernetes.io/is-default-class':'true'}},provisioner:'unclassified.example/csi'}]};
const configuration=extra=>({...resolve(config({procedureVersion:12,domain:'example.com',email:'m@example.com',timeoutSeconds:60,...extra}),{items:[]},classes,{}),tlsMode:'acme',internalGatewayRouting:extra?.gatewayRouting!=='public'});

// Argo, controller and certificate evolve independently; a template change
// alone does not grant permission to enter tenant-tls.
function clusterModel({readyAt=45000,rollout=true}={}){
 let now=0,patchedAt,patches=0,ip='100.64.15.17',mappedIP,requestedIP;
 const events=[],commands=[];
 const appset={metadata:{resourceVersion:'123'},spec:{template:{spec:{source:{repoURL:repository}}},templatePatch:'{{ if eq .path.path "INFRA/network/envoy" }}existing{{ end }}\n'}};
 const aliases=()=>[{ip:'100.64.7.9',hostnames:['unrelated.example.com']},...(mappedIP?[{ip:mappedIP,hostnames:[host]}]:[])];
 const deployment=()=>({metadata:{name:'cert-manager',generation:mappedIP?2:1},spec:{replicas:1,template:{spec:{hostAliases:aliases()}}},status:{observedGeneration:mappedIP?2:1,replicas:1,updatedReplicas:1,availableReplicas:1}});
 const pods=()=>({items:[{metadata:{name:'cert-manager-pod'},spec:{hostAliases:rollout&&patchedAt!==undefined&&now-patchedAt>=6000?aliases():[]},status:{phase:'Running',conditions:[{type:'Ready',status:now-(patchedAt??now)>=9000?'True':'False'}]}}]});
 const ready=()=>now>=readyAt;
 const r={emit:e=>events.push({at:now,...e}),json:async(cmd,args)=>{
  commands.push({at:now,args});
  if(args.includes('services'))return {items:[{metadata:{name:'envoy-generated'},spec:{type:'LoadBalancer',clusterIP:ip,ports:ready()?[{port:80},{port:443}]:[{port:80}]},status:{loadBalancer:{ingress:[{ip:'192.0.2.8'}]}}}]};
  if(args.includes('deployments'))return {items:[deployment()]};
  if(args.includes('pods'))return pods();
  if(args.includes('applicationset'))return appset;
  if(args.includes('challenges.acme.cert-manager.io'))return {items:ready()?[]:[{metadata:{name:'existing-pending-request'},spec:{dnsName:host},status:{state:'pending',reason:'Waiting for HTTP-01 challenge propagation: self-check timeout'}}]};
  if(args.includes('certificate')||args.includes('listenerset'))return {metadata:{generation:1},status:{conditions:[{type:args.includes('certificate')?'Ready':'Programmed',observedGeneration:1,status:ready()?'True':'False'}]}};
  throw Error('Unexpected read: '+args.join(' '));
 },run:async(cmd,args)=>{
  assert.deepEqual(args.slice(0,6),['-n','argocd','patch','applicationset','network','--type=json']);
  const patch=JSON.parse(args.at(-1));
  assert.equal(patch[0].value,'123');
  appset.spec.templatePatch=patch[1].value;
  requestedIP=ip;patchedAt=now;patches++;
 }};
 const timing={now:()=>now,sleep:async ms=>{now+=ms;if(patchedAt!==undefined&&now-patchedAt>=3000)mappedIP=requestedIP;}};
 return {r,timing,events,commands,appset,get patches(){return patches;},setIP:value=>{ip=value;},get now(){return now;}};
}

test('automatic routing applies to every provider including undetected clusters and explicit generic',()=>{
 for(const provider of require('../lib/providers').PROVIDERS){
  const c=configuration({provider,lbNetworkZone:'eu-central'});assert.equal(c.internalGatewayRouting,true,provider);
 }
 assert.equal(configuration().actualProvider,'generic');
 // Measured with the distributed 12.1.1 source on this same unknown-provider plan.
 assert.equal(fingerprint(configuration()),'b0c4d05a466c61a62448e6851359de1ab8ed1ad90aa82716edde3015ab94ca9e');
 assert.equal(configuration({gatewayRouting:'public'}).internalGatewayRouting,false);
});

test('a resumed unknown-provider deployment repairs empty aliases before TLS and reports pending ACME progress',async()=>{
 const model=clusterModel();
 await waitTenantTls(model.r,configuration(),model.timing);
 assert.equal(model.patches,1);
 assert.match(model.appset.spec.templatePatch,/existing/);
 assert.match(model.appset.spec.templatePatch,/100\.64\.15\.17/);
 const tlsStart=model.events.find(e=>e.type==='phase'&&e.phase==='tenant-tls');
 assert.equal(tlsStart.at,9000);
 assert.ok(model.events.some(e=>e.type==='routing-progress'&&e.rolledOut&&!e.ready));
 assert.ok(model.events.some(e=>e.type==='routing-progress'&&e.ready&&e.at<=tlsStart.at));
 assert.ok(model.commands.filter(e=>e.args.includes('certificate')).every(e=>e.at>=tlsStart.at));
 const progress=model.events.filter(e=>e.type==='tls-progress');
 assert.ok(progress.length>=4);
 assert.match(progress[0].message,/self-check timeout/);
 assert.equal(progress[0].challenges[0].name,'existing-pending-request');
 assert.deepEqual(progress[0].gatewayAddresses,['192.0.2.8']);
 assert.equal(progress.at(-1).certificateReady,true);
 assert.equal(progress.at(-1).listenerProgrammed,true);
 assert.equal(progress.at(-1).httpsPortReady,true);
 for(let i=1;i<progress.length;i++)assert.ok(progress[i].at-progress[i-1].at<=12000);
 assert.ok(model.commands.every(e=>!e.args.some(x=>['delete','renew','certificaterequest','order'].includes(x))));
 // A repeat run retains the existing managed block without a second write.
 await waitTenantTls(model.r,configuration(),model.timing);assert.equal(model.patches,1);
});

test('TLS is blocked when controller templates are mapped but current pods are not',async()=>{
 const model=clusterModel({readyAt:0,rollout:false});
 await assert.rejects(waitTenantTls(model.r,{...configuration(),timeoutSeconds:12},model.timing),{code:'GATEWAY_ROUTING_TIMEOUT'});
 assert.ok(!model.events.some(e=>e.phase==='tenant-tls'));
 assert.ok(!model.commands.some(e=>e.args.includes('certificate')));
});

test('replaced gateway addresses are discovered and reconciled during the TLS wait',async()=>{
 const model=clusterModel({readyAt:48000});
 const original=model.r.emit;
 let changed=false;
 model.r.emit=e=>{original(e);if(e.type==='tls-progress'&&!changed){model.setIP('100.64.28.19');changed=true;}};
 await waitTenantTls(model.r,configuration(),model.timing);
 assert.equal(model.patches,2);
 assert.ok(model.events.some(e=>e.type==='routing-drift'&&e.clusterIP==='100.64.28.19'));
 assert.match(model.appset.spec.templatePatch,/100\.64\.28\.19/);
 assert.doesNotMatch(model.appset.spec.templatePatch,/100\.64\.15\.17/);
 assert.equal(model.events.filter(e=>e.type==='tls-progress').at(-1).clusterIP,'100.64.28.19');
});

test('pending TLS errors remain visible and finish within the configured wait',async()=>{
 const model=clusterModel({readyAt:Infinity});
 await assert.rejects(waitTenantTls(model.r,{...configuration(),timeoutSeconds:15},model.timing),e=>e.code==='TENANT_TLS_NOT_READY'&&e.message.includes('self-check timeout')&&e.message.includes('192.0.2.8'));
 assert.equal(model.now,24000); // Nine-second rollout plus the full TLS budget.
 assert.ok(model.events.filter(e=>e.type==='tls-progress').length>=2);
});

test('explicit public mode emits its choice and makes no controller or ApplicationSet mutation',async()=>{
 const model=clusterModel({readyAt:0});
 await waitTenantTls(model.r,configuration({gatewayRouting:'public'}),model.timing);
 assert.equal(model.patches,0);
 assert.ok(model.commands.every(e=>!e.args.includes('deployments')&&!e.args.includes('pods')));
 assert.equal(model.events.find(e=>e.phase==='tenant-tls').routingMode,'public');
});
