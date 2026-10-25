'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {aliasesFor,routingTemplate,publicService,proxyPorts,internalValues,internalRouting,waitTenantTls}=require('../lib/gateway-routing');
const {networkValues}=require('../lib/adapt');
const {config,resolve,fingerprint}=require('../lib/config');
const repository=require('../upstream-lock.json').repository;
const service={metadata:{name:'discovered-proxy'},spec:{type:'LoadBalancer',clusterIP:'100.64.9.12',ports:[{port:80},{port:443}]}};
const host='demo-tenant.example.com';
test('routing replaces only the selected hostname and preserves unrelated host mappings',()=>{
 const previous=[{ip:'100.64.1.1',hostnames:[host,'other.example.com']},{ip:'100.64.9.12',hostnames:['keep.example.com']}];
 assert.deepEqual(aliasesFor(previous,host,'100.64.9.12'),[{ip:'100.64.1.1',hostnames:['other.example.com']},{ip:'100.64.9.12',hostnames:['keep.example.com',host]}]);
 assert.equal(previous[0].hostnames.length,2);
});
test('internal routing preserves Envoy policy, DNS branches and literal hostname values',()=>{
 const base=networkValues({actualProvider:'ionos',externalDns:true,actualDns:'custom',dnsValues:{provider:{name:'cloudflare'}},lbAnnotations:{}}).esbTemplatePatch;
 const aliases=[{ip:'100.64.9.12',hostnames:[host]}],text=routingTemplate(base,aliases);
 assert.ok(text.startsWith(base.trimEnd()));assert.match(text,/RespectIgnoreDifferences=true/);assert.match(text,/INFRA\/network\/external-dns/);
 const literal=[...text.matchAll(/values: \{\{ (.+) \}\}/g)].at(-1)[1];
 assert.deepEqual(JSON.parse(JSON.parse(JSON.parse(literal))),{'cert-manager':{hostAliases:aliases}});
 assert.equal(routingTemplate(text,aliases),text);
 assert.throws(()=>routingTemplate(base+'\n{{ if eq .path.path "INFRA/network/cert-manager" }}custom{{ end }}',aliases),{code:'GATEWAY_ROUTING'});
});
test('routing discovers the proxy by labels and refuses ambiguous or headless Services',async()=>{
 const runner=items=>({json:async()=>({items})});
 assert.equal((await publicService(runner([service]))).spec.clusterIP,'100.64.9.12');
 await assert.rejects(publicService(runner([service,service])),{code:'GATEWAY_ROUTING'});
 await assert.rejects(publicService(runner([{...service,spec:{...service.spec,clusterIP:'None'}}])),{code:'GATEWAY_ROUTING'});
});
test('UI egress includes the translated backend ports and resolves named ports from EndpointSlices',async()=>{
 const elevated={...service,spec:{...service.spec,ports:[{port:80,targetPort:10080},{port:443,targetPort:10443}]}};
 assert.deepEqual(await proxyPorts({},elevated),[80,443,10080,10443]);
 const named={...service,spec:{...service.spec,ports:[{port:80,targetPort:'http'},{port:443,targetPort:'https'}]}};
 assert.deepEqual(await proxyPorts({json:async()=>({items:[{ports:[{port:10080},{port:10443}]}]})},named),[80,443,10080,10443]);
 await assert.rejects(proxyPorts({json:async()=>({items:[]})},named),{code:'GATEWAY_ROUTING'});
});
test('routing is durable in the ApplicationSet and waits for the generated controller rollout',async()=>{
 let writes=0;
 const deployment={metadata:{name:'cert-manager',generation:2},spec:{replicas:1,template:{spec:{hostAliases:[{ip:'100.64.9.12',hostnames:[host]}]}}},status:{replicas:1,observedGeneration:2,updatedReplicas:1,availableReplicas:1}};
 const appset={metadata:{resourceVersion:'123'},spec:{template:{spec:{source:{repoURL:repository}}},templatePatch:'{{ if eq .path.path "INFRA/network/envoy" }}existing{{ end }}\n'}};
 const r={emit(){},json:async(cmd,args)=>args.includes('services')?{items:[service]}:args.includes('deployments')?{items:[deployment]}:appset,run:async(cmd,args)=>{writes++;const p=JSON.parse(args.at(-1));assert.equal(p[0].value,'123');assert.equal(p[1].path,'/spec/templatePatch');appset.spec.templatePatch=p[1].value;}};
 await internalRouting(r,{tenantHost:host,internalGatewayRouting:true,timeoutSeconds:1});assert.equal(writes,1);
 await internalRouting(r,{tenantHost:host,internalGatewayRouting:true,timeoutSeconds:1});assert.equal(writes,1);
});
test('existing network Helm upgrades include the mapping before reconciliation',async()=>{
 const r={json:async(cmd,args)=>args.includes('services')?{items:[service]}:{items:[{spec:{replicas:1,template:{spec:{hostAliases:[]}}}}]}};
 const base=networkValues({actualProvider:'ionos',lbAnnotations:{}});
 const values=await internalValues(r,{internalGatewayRouting:true,tenantHost:host},base);
 assert.equal(values.esbTemplatePatch,routingTemplate(base.esbTemplatePatch,[{ip:'100.64.9.12',hostnames:[host]}]));
 assert.equal(await internalValues({}, {internalGatewayRouting:false},base),base);
});
test('tenant readiness refuses the supplied certificate/ListenerSet/HTTP-only failure',async()=>{
 const pending={metadata:{generation:1},status:{conditions:[{type:'Ready',status:'False',observedGeneration:1}]}};
 const listener={metadata:{generation:1},status:{conditions:[{type:'Programmed',status:'False',observedGeneration:1}]}};
 const r={emit(){},json:async(cmd,args)=>args.includes('certificate')?pending:args.includes('listenerset')?listener:args.includes('services')?{items:[{...service,spec:{...service.spec,ports:[{port:80}]}}]}:{items:[{spec:{dnsName:host},status:{reason:'HTTP-01 self-check timeout'}}]}};
 await assert.rejects(waitTenantTls(r,{tenantRelease:'demotenant',tenantHost:host,timeoutSeconds:0}),e=>e.code==='TENANT_TLS_NOT_READY'&&e.message.includes('self-check timeout')&&e.message.includes('UI installation was not started'));
});
test('tenant readiness requires a current programmed listener, ready certificate and port 443',async()=>{
 const r={emit(){},json:async(cmd,args)=>args.includes('services')?{items:[service]}:{metadata:{generation:2},status:{conditions:[{type:args.includes('certificate')?'Ready':'Programmed',status:'True',observedGeneration:2}]}}};
 await waitTenantTls(r,{tenantRelease:'demotenant',tenantHost:host,timeoutSeconds:0});
});
test('IONOS automatically uses internal routing without changing the installation fingerprint',()=>{
 const classes={items:[{metadata:{name:'ionos',annotations:{'storageclass.kubernetes.io/is-default-class':'true'}},provisioner:'ionos'}]};
 const c=resolve(config({procedureVersion:12,domain:'example.com',email:'m@example.com'}),{items:[]},classes,{});
 assert.equal(c.internalGatewayRouting,true);
 assert.equal(fingerprint(c),fingerprint({...c,gatewayRouting:'public',internalGatewayRouting:false,gatewayClusterIP:'100.64.1.2'}));
 const other=resolve(config({procedureVersion:12,domain:'example.com',email:'m@example.com',provider:'generic'}),{items:[]},classes,{});
 assert.equal(other.internalGatewayRouting,false);
});

test('12.1.0 native installation fingerprint remains compatible with 12.1.1',()=>{
 const classes={items:[{metadata:{name:'ionos',annotations:{'storageclass.kubernetes.io/is-default-class':'true'}},provisioner:'ionos'}]};
 const input={procedureVersion:12,domain:'example.com',email:'m@example.com'};
 // Golden native fingerprint measured with the distributed 12.1.0 code.
 const c=resolve(config(input),{items:[]},classes,{});
 assert.equal(fingerprint(c),'86af49a57d22167978be30f37ca61b494c3fc27d873db52cddb10dc32fffa437');
});
