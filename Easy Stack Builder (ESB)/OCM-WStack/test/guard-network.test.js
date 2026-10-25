'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {rules}=require('../lib/kube-api-egress'),guard=require('../lib/ocm-guard');
const {jsonRequest,failureStatus}=require('../scripts/ocm-guard');
// Service and legacy backend tuples reported by the user on 13 October 2026.
function service(){return {metadata:{name:'kubernetes',namespace:'default'},spec:{clusterIP:'100.64.0.1',clusterIPs:['100.64.0.1'],ports:[{name:'https',port:443,protocol:'TCP',targetPort:15370}]}};}
function legacy(){return {metadata:{name:'kubernetes',namespace:'default'},subsets:[{addresses:[{ip:'213.165.72.144'},{ip:'213.165.72.147'}],notReadyAddresses:[{ip:'192.0.2.99'}],ports:[{name:'https',port:15370,protocol:'TCP'}]}]};}
function slices(){return {items:[{metadata:{namespace:'default',labels:{'kubernetes.io/service-name':'kubernetes'}},addressType:'IPv4',ports:[{name:'https',port:16443,protocol:'TCP'}],endpoints:[{addresses:['192.0.2.10'],conditions:{ready:true}},{addresses:['192.0.2.20'],conditions:{ready:false}},{addresses:['192.0.2.30'],conditions:{ready:true,terminating:true}}]}]};}
function permits(rows,ip,port){return rows.some(rule=>rule.ports.some(p=>p.protocol==='TCP'&&p.port===port)&&rule.to.some(peer=>peer.ipBlock.cidr===ip+'/'+(ip.includes(':')?128:32)));}
test('the reported API route is allowed both before and after Service translation, without opening other IPs or ports',()=>{
 const rows=rules(service(),{items:[]},legacy());
 assert.ok(permits(rows,'100.64.0.1',443));
 for(const ip of ['213.165.72.144','213.165.72.147'])assert.ok(permits(rows,ip,15370));
 assert.equal(permits(rows,'192.0.2.99',15370),false);
 assert.equal(permits(rows,'213.165.72.144',6443),false);
 assert.equal(permits(rows,'100.64.0.1',15370),false);
 assert.ok(rows.every(r=>r.to.every(p=>!['0.0.0.0/0','::/0'].includes(p.ipBlock.cidr))));
 assert.deepEqual(rows,rules(service(),{items:[]},{...legacy(),subsets:[{...legacy().subsets[0],addresses:legacy().subsets[0].addresses.slice().reverse()}]}));
});
test('EndpointSlices select ready API backends and support nonstandard ports and dual-stack addresses',()=>{
 const svc=service(),list=slices();svc.spec.clusterIPs.push('2001:db8::1');
 list.items.push({...structuredClone(list.items[0]),addressType:'IPv6',endpoints:[{addresses:['2001:db8::10'],conditions:{ready:true}}]});
 list.items.push({...structuredClone(list.items[0]),metadata:{namespace:'default',labels:{'kubernetes.io/service-name':'foreign'}},endpoints:[{addresses:['192.0.2.40']}]});
 const rows=rules(svc,list,legacy());assert.ok(permits(rows,'2001:db8::1',443));assert.ok(permits(rows,'2001:db8::10',16443));assert.ok(permits(rows,'192.0.2.10',16443));
 for(const ip of ['192.0.2.20','192.0.2.30','192.0.2.40','213.165.72.144'])assert.equal(permits(rows,ip,16443),false);
 assert.ok(!rows.some(r=>r.ports.some(p=>p.port===15370)));
});
test('API discovery rejects invalid routes and never guesses a port or opens egress for missing backends',()=>{
 for(const change of [svc=>svc.spec.clusterIP='invalid',svc=>svc.spec.ports[0].port=0,svc=>svc.metadata.namespace='foreign']){
  const svc=service();change(svc);assert.throws(()=>rules(svc,{items:[]},legacy()),{code:'GUARD_API_SERVICE'});
 }
 for(const change of [list=>list.items[0].ports[0].port=70000,list=>list.items[0].endpoints[0].addresses=['2001:db8::bad']]){
  const list=slices();change(list);assert.throws(()=>rules(service(),list),{code:'GUARD_API_ENDPOINTS'});
 }
 assert.throws(()=>rules(service(),{items:[]}),{code:'GUARD_API_ENDPOINTS_PENDING'});
 const endpoints=legacy();endpoints.subsets[0].addresses=[];assert.throws(()=>rules(service(),{items:[]},endpoints),{code:'GUARD_API_ENDPOINTS_PENDING'});
});
test('guard installation discovers current routes before writes, prefers slices and keeps the existing infrastructure access',async()=>{
 for(const useSlices of [true,false]){
  let writes=0,legacyReads=0;const events=[];
  const r={json:async(cmd,args)=>{assert.equal(cmd,'kubectl');if(args.includes('default')){if(args.includes('service'))return service();if(args.includes('endpointslices.discovery.k8s.io'))return useSlices?slices():{items:[]};if(args.includes('endpoints')){legacyReads++;return legacy();}assert.fail('Unexpected discovery');}return null;},run:async(cmd,args,options)=>{writes++;const docs=JSON.parse(options.input).items,policy=docs.find(d=>d.kind==='NetworkPolicy');assert.deepEqual(policy.spec.podSelector,{matchLabels:{app:'esb-ocm-guard'}});assert.ok(permits(policy.spec.egress,'100.64.0.1',443));assert.ok(permits(policy.spec.egress,useSlices?'192.0.2.10':'213.165.72.144',useSlices?16443:15370));assert.ok(policy.spec.egress.some(row=>row.to?.some(peer=>peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']==='infrastructure')&&row.ports.some(p=>p.port===8222)));assert.ok(!policy.spec.egress.some(row=>!row.to&&row.ports.some(p=>p.port===443||p.port===6443)));},emit:e=>events.push(e)};
  await guard.install(r,'ecofacis/xfsc-orce:2.0.15');assert.equal(writes,1);assert.equal(legacyReads,useSlices?0:1);assert.deepEqual(events[0].apiPorts,[443,useSlices?16443:15370]);
 }
 let writes=0;const r={json:async(cmd,args)=>args.includes('default')?(args.includes('service')?service():{items:[],metadata:{name:'kubernetes',namespace:'default'},subsets:[]}):null,run:async()=>{writes++;},emit(){}};
 await assert.rejects(guard.install(r,'ecofacis/xfsc-orce:2.0.15'),{code:'GUARD_API_ENDPOINTS_PENDING'});assert.equal(writes,0);
});
async function peer(t,handler){const sockets=new Set(),server=http.createServer(handler);server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{for(const socket of sockets)socket.destroy();server.close();});return server;}
test('a stalled HTTP connection reports the target and bounded timeout without credentials or request contents',async t=>{
 const server=await peer(t,()=>{}),port=server.address().port,started=Date.now();
 await assert.rejects(jsonRequest(`http://private-user:private-password@127.0.0.1:${port}/hidden?token=hidden-token`,{target:'kubernetes-api',operation:'list/deployments',headers:{Authorization:'Bearer hidden-auth'},timeoutMs:40}),e=>{
  assert.equal(e.code,'GUARD_TRANSPORT');assert.deepEqual(e.connection,{target:'kubernetes-api',operation:'list/deployments',host:'127.0.0.1',port,cause:'ETIMEDOUT'});
  const status=failureStatus(e,()=>0);assert.equal(status.ready,false);assert.equal(status.checkedAt,'1970-01-01T00:00:00.000Z');assert.deepEqual(status.connection,e.connection);
  assert.ok(!/private-user|private-password|hidden-token|hidden-auth|\/hidden/.test(JSON.stringify(status)));return true;
 });assert.ok(Date.now()-started<2000);
});
test('HTTP rejection, invalid JSON and aborted responses identify the correct target without leaking response bodies',async t=>{
 const server=await peer(t,(req,res)=>{if(req.url==='/denied'){res.writeHead(403);res.end('hidden-secret');}else if(req.url==='/invalid'){res.end('hidden-secret');}else{res.writeHead(200,{'Content-Length':'999'});res.write('{');setImmediate(()=>res.destroy());}}),base='http://127.0.0.1:'+server.address().port;
 for(const [route,code,cause] of [['denied','GUARD_HTTP','HTTP_STATUS'],['invalid','GUARD_JSON','INVALID_JSON'],['aborted','GUARD_TRANSPORT','ECONNRESET']]){
  await assert.rejects(jsonRequest(base+'/'+route,{target:'nats-monitor',operation:'connz',timeoutMs:500}),e=>{assert.equal(e.code,code);assert.equal(e.connection.target,'nats-monitor');assert.equal(e.connection.cause,cause);assert.ok(!JSON.stringify(failureStatus(e)).includes('hidden-secret'));if(route==='denied')assert.equal(e.status,403);return true;});
 }
});
