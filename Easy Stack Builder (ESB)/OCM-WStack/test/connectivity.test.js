'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {waitDns}=require('../lib/connectivity'),{networkValues}=require('../lib/adapt'),lock=require('../upstream-lock.json');
test('DNS wait covers dashboard hosts and rejects stale AAAA before succeeding',async()=>{
 let now=0;const events=[];const r={emit:e=>events.push(e),json:async()=>({items:[{metadata:{name:'envoy-dynamic'},spec:{type:'LoadBalancer',clusterIP:'100.64.1.4',ports:[{port:80},{port:443}]},status:{loadBalancer:{ingress:[{ip:'192.0.2.8'}]}}}]})};
 const records=await waitDns(r,{tenantHost:'wallet.example.com',domain:'example.com',publicDashboards:true,externalDns:false,timeoutSeconds:30},{now:()=>now,pause:async ms=>{now+=ms;},resolve:async h=>h==='argocd.example.com'&&now===0?['192.0.2.8','2001:db8::bad']:['192.0.2.8']});
 assert.equal(records.length,3);assert.equal(events.length,2);assert.equal(events[0].records[1].ready,false);assert.equal(records.every(x=>x.ready),true);
});
test('all network applications stay frozen and uploaded TLS excludes ACME issuer with either DNS setting',()=>{
 for(const externalDns of [false,true]){const values=networkValues({externalDns,actualProvider:'generic',lbAnnotations:{}});assert.equal(values.tag,lock.commit);assert.ok(values.excludes.includes('INFRA/network/cluster-issuer'));assert.equal(values.excludes.includes('INFRA/network/external-dns'),!externalDns);}
});
test('native hostname routing follows the discovered gateway, preserves unrelated aliases and is idempotent',async()=>{
 const {nativeRouting}=require('../lib/gateway');let writes=0,rollouts=0;
 const item={kind:'Deployment',metadata:{name:'credential-retrieval-service',resourceVersion:'4'},spec:{template:{spec:{hostAliases:[{ip:'100.64.1.2',hostnames:['wallet.example.com','keep.example.com']}]}}}};
 const r={emit(){},json:async(cmd,args)=>args.includes('services')?{items:[{metadata:{name:'generated'},spec:{type:'LoadBalancer',clusterIP:'100.64.9.8',ports:[{port:80}]}}]}:{items:[item]},run:async(cmd,args)=>{if(args.includes('patch')){writes++;item.spec.template.spec.hostAliases=JSON.parse(args.at(-1))[1].value;}else{rollouts++;assert.ok(args.includes('deployment/credential-retrieval-service'));}}};
 await nativeRouting(r,{tenantHost:'wallet.example.com',timeoutSeconds:60});await nativeRouting(r,{tenantHost:'wallet.example.com',timeoutSeconds:60});
 assert.equal(writes,1);assert.equal(rollouts,1);assert.deepEqual(item.spec.template.spec.hostAliases,[{ip:'100.64.1.2',hostnames:['keep.example.com']},{ip:'100.64.9.8',hostnames:['wallet.example.com']}]);
});

test('completion waits for startup but stops immediately on a native HTTP contract rejection',async()=>{
 const {waitValidation}=require('../lib/install');let time=0,calls=0;const events=[],r={emit:e=>events.push(e)};
 const report=await waitValidation(r,{timeoutSeconds:60},{check:async()=>({status:++calls===2?'ready':'action-required'}),now:()=>time,pause:async ms=>time+=ms});assert.equal(report.status,'ready');assert.equal(time,5000);assert.equal(events.length,2);
 calls=0;await waitValidation(r,{timeoutSeconds:60},{check:async()=>{calls++;return {status:'action-required',ui:{checks:[{name:'ui-ready',dependencies:[{name:'storage',ok:false,httpStatus:400,reason:'STORAGE_REGION_MISSING'}]}]}};},now:()=>0,pause:async()=>assert.fail('must not wait on a permanent contract error')});assert.equal(calls,1);
});
