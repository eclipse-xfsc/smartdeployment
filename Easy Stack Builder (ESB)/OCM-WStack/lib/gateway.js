'use strict';
const path=require('node:path');
const {upgrade}=require('./api-recovery');
const {fail}=require('./config');
async function policy(r,c){
 const service=await require('./gateway-routing').publicService(r);
 await upgrade(r,['upgrade','--install','esb-ocm-gateway',path.join(__dirname,'../charts-gateway'),'-n','security','--set-string',`externalTrafficPolicy=${c.externalTrafficPolicy}`,'--set-string',`tenantHost=${c.tenantHost}`,'--set-string',`gatewayClusterIP=${service.spec.clusterIP}`,'--timeout',`${c.timeoutSeconds}s`],{namespace:'security',release:'esb-ocm-gateway',timeout:(c.timeoutSeconds+30)*1000});
 await r.run('kubectl',['wait','clusterpolicy/esb-ocm-tenant-routing','--for=condition=Ready',`--timeout=${c.timeoutSeconds}s`],{timeout:(c.timeoutSeconds+30)*1000});
 await r.run('kubectl',['wait','clusterpolicy/esb-ocm-envoy-traffic','--for=condition=Ready',`--timeout=${c.timeoutSeconds}s`],{timeout:(c.timeoutSeconds+30)*1000});
 await r.run('kubectl',['wait','clusterpolicy/esb-ocm-didcomm-startup','--for=condition=Ready',`--timeout=${c.timeoutSeconds}s`],{timeout:(c.timeoutSeconds+30)*1000});
 await r.run('kubectl',['wait','clusterpolicy/esb-ocm-retrieval-startup','--for=condition=Ready',`--timeout=${c.timeoutSeconds}s`],{timeout:(c.timeoutSeconds+30)*1000});
}
async function reconcile(r,c){
 const proxy=await r.json('kubectl',['-n','infrastructure','get','envoyproxy','envoy','-o','json']);
 const svc=proxy.spec?.provider?.kubernetes?.envoyService;
 if(!svc)fail('GATEWAY_CONFIG','The upstream EnvoyProxy has no Kubernetes envoyService configuration.');
 if(svc.externalTrafficPolicy!==c.externalTrafficPolicy)await r.run('kubectl',['-n','infrastructure','patch','envoyproxy','envoy','--type=merge','-p',JSON.stringify({spec:{provider:{kubernetes:{envoyService:{externalTrafficPolicy:c.externalTrafficPolicy}}}}})]);
 // Discover generated proxy Services, never use observed hashes/IPs/NodePorts.
 const list=await r.json('kubectl',['-n','infrastructure','get','services','-l','gateway.envoyproxy.io/owning-gateway-name=envoy-gateway,gateway.envoyproxy.io/owning-gateway-namespace=infrastructure','-o','json']);
 for(const s of list.items||[]){if(s.spec.type!=='LoadBalancer')continue;
  if(s.spec.externalTrafficPolicy!==c.externalTrafficPolicy)await r.run('kubectl',['-n','infrastructure','patch','service',s.metadata.name,'--type=merge','-p',JSON.stringify({spec:{externalTrafficPolicy:c.externalTrafficPolicy}})]);
 }
 await require('./gateway-routing').internalRouting(r,c);
 r.emit({type:'gateway-configured',externalTrafficPolicy:c.externalTrafficPolicy,proxy:'infrastructure/envoy',services:(list.items||[]).filter(s=>s.spec.type==='LoadBalancer').map(s=>s.metadata.name)});
}
async function nativeRouting(r,c){
 const service=await require('./gateway-routing').publicService(r),{aliasesFor}=require('./gateway-routing');
 const changed=[];
 for(const namespace of ['ocm-wstack','infrastructure']){
 const list=await r.json('kubectl',['-n',namespace,'get','deployments,statefulsets','-o','json']);
 for(const item of list.items||[]){
  if(/^ocm-(?:ui-|orce)/.test(item.metadata.name)||namespace==='infrastructure'&&!/resolver|driver-did/.test(item.metadata.name))continue;
  const before=item.spec.template.spec.hostAliases||[],aliases=aliasesFor(before,c.tenantHost,service.spec.clusterIP);
  if(JSON.stringify(before)===JSON.stringify(aliases))continue;
  await r.run('kubectl',['-n',namespace,'patch',item.kind.toLowerCase(),item.metadata.name,'--type=json','-p',JSON.stringify([{op:'test',path:'/metadata/resourceVersion',value:item.metadata.resourceVersion},{op:'add',path:'/spec/template/spec/hostAliases',value:aliases}])]);
  changed.push({namespace,resource:item.kind.toLowerCase()+'/'+item.metadata.name});
 }
 }
 for(const {namespace,resource} of changed)await r.run('kubectl',['-n',namespace,'rollout','status',resource,`--timeout=${c.timeoutSeconds}s`],{timeout:(c.timeoutSeconds+30)*1000});
 r.emit({type:'native-routing',hostname:c.tenantHost,clusterIP:service.spec.clusterIP,updated:changed});
 return {hostname:c.tenantHost,clusterIP:service.spec.clusterIP,updated:changed};
}
module.exports={policy,reconcile,nativeRouting,...require('./gateway-routing')};
