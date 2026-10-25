'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {waitDns}=require('../lib/connectivity'),{networkValues}=require('../lib/adapt'),lock=require('../upstream-lock.json');
test('DNS wait covers dashboard hosts and rejects stale AAAA before succeeding',async()=>{
 let now=0;const events=[];const r={emit:e=>events.push(e),json:async()=>({items:[{metadata:{name:'envoy-dynamic'},spec:{type:'LoadBalancer',clusterIP:'100.64.1.4',ports:[{port:80},{port:443}]},status:{loadBalancer:{ingress:[{ip:'192.0.2.8'}]}}}]})};
 const records=await waitDns(r,{tenantHost:'wallet.example.com',domain:'example.com',publicDashboards:true,externalDns:false,timeoutSeconds:30},{now:()=>now,pause:async ms=>{now+=ms;},resolve:async h=>h==='argocd.example.com'&&now===0?['192.0.2.8','2001:db8::bad']:['192.0.2.8']});
 assert.equal(records.length,3);assert.equal(events.length,2);assert.equal(events[0].records[1].ready,false);assert.equal(records.every(x=>x.ready),true);
});
test('network Git applications follow main and uploaded TLS excludes ACME issuer with either DNS setting',()=>{
 for(const externalDns of [false,true]){const values=networkValues({externalDns,actualProvider:'generic',lbAnnotations:{}});assert.equal(values.tag,'main');assert.ok(values.excludes.includes('INFRA/network/cluster-issuer'));assert.equal(values.excludes.includes('INFRA/network/external-dns'),!externalDns);}
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

test('two matching public resolvers recover stale or blocked local DNS',async()=>{
 const {lookup}=require('../lib/connectivity');
 for(const stale of [[],['192.0.2.99'],['192.0.2.8','2001:db8::bad']]){
  const result=await lookup('wallet.example.com',['192.0.2.8'],{local:async()=>({source:'system',addresses:stale,complete:stale.length>0,errors:stale.length?[]:[{type:'A',code:'ETIMEOUT'}]}),publicResolve:async(h,p)=>({source:p,addresses:['192.0.2.8'],complete:true,errors:[]})});
  assert.equal(result.ready,true);assert.equal(result.source,'public-consensus');assert.equal(result.views.length,3);
 }
});
test('a stale public AAAA or unavailable second public resolver cannot be hidden',async()=>{
 const {lookup}=require('../lib/connectivity');
 for(const second of [{addresses:['192.0.2.8','2001:db8::bad'],complete:true,errors:[]},{addresses:[],complete:false,errors:[{type:'AAAA',code:'ETIMEOUT'}]}]){
  const result=await lookup('wallet.example.com',['192.0.2.8'],{local:async()=>({source:'system',addresses:['192.0.2.99'],complete:true,errors:[]}),publicResolve:async(h,p)=>({source:p,...(p==='google'?second:{addresses:['192.0.2.8'],complete:true,errors:[]})})});
  assert.equal(result.ready,false);
 }
});
test('DNS over HTTPS follows address answers and reports partial lookup failures',async()=>{
 const {publicLookup}=require('../lib/connectivity');
 const ok=await publicLookup('wallet.example.com','google',{query:async url=>({Status:0,Answer:url.searchParams.get('type')==='A'?[{type:5,data:'lb.example.com.'},{type:1,data:'192.0.2.8'}]:[]})});
 assert.deepEqual(ok.addresses,['192.0.2.8']);assert.equal(ok.complete,true);
 const partial=await publicLookup('wallet.example.com','cloudflare',{query:async url=>url.searchParams.get('type')==='A'?{Status:0,Answer:[{type:1,data:'192.0.2.8'}]}:{Status:2}});
 assert.equal(partial.complete,false);assert.equal(partial.errors[0].type,'AAAA');assert.equal(partial.errors[0].code,'DNS_RCODE_2');
});
test('matching IPv6 formats do not fail equality and local success needs no fallback',async()=>{
 const {lookup}=require('../lib/connectivity');
 const result=await lookup('wallet.example.com',['2001:db8:0:0:0:0:0:8'],{local:async()=>({source:'system',addresses:['2001:db8::8'],complete:true,errors:[]}),publicResolve:async()=>assert.fail('unnecessary fallback')});assert.equal(result.ready,true);
});
test('DNS timeout reports the hostname, resolver errors and retains installed resources',async()=>{
 const r={emit(){},json:async()=>({items:[{metadata:{name:'envoy'},spec:{type:'LoadBalancer',clusterIP:'100.64.1.4',ports:[{port:80},{port:443}]},status:{loadBalancer:{ingress:[{ip:'85.215.138.83'}]}}}]})};
 await assert.rejects(waitDns(r,{tenantHost:'demo-tenant.example.com',timeoutSeconds:0},{check:async hostname=>({hostname,ready:false,addresses:[],views:[{source:'system',complete:false,addresses:[],errors:[{type:'A',code:'ECONNREFUSED'}]}]})}),e=>e.code==='DNS_RESOLUTION_FAILED'&&e.message.includes('demo-tenant.example.com')&&e.message.includes('ECONNREFUSED')&&e.message.includes('retained'));
});
test('Public validation transport can use verified DNS answers without losing the original Host',async t=>{
 const http=require('node:http'),{request}=require('../lib/native');
 const server=http.createServer((req,res)=>{assert.equal(req.headers.host,'wallet.invalid:'+server.address().port);res.setHeader('content-type','application/json');res.end('{"ready":true}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const result=await request('http://wallet.invalid:'+server.address().port+'/health',{addresses:['127.0.0.1']});assert.equal(result.ok,true);assert.equal(result.data.ready,true);
});
