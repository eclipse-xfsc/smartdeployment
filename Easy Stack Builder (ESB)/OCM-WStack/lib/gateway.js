'use strict';
const path=require('node:path');
const {upgrade}=require('./api-recovery');
const {fail}=require('./config');
async function policy(r,c){
 await upgrade(r,['upgrade','--install','esb-ocm-gateway',path.join(__dirname,'../charts-gateway'),'-n','security','--set-string',`externalTrafficPolicy=${c.externalTrafficPolicy}`,'--timeout',`${c.timeoutSeconds}s`],{namespace:'security',release:'esb-ocm-gateway',timeout:(c.timeoutSeconds+30)*1000});
 await r.run('kubectl',['wait','clusterpolicy/esb-ocm-envoy-traffic','--for=condition=Ready',`--timeout=${c.timeoutSeconds}s`],{timeout:(c.timeoutSeconds+30)*1000});
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
module.exports={policy,reconcile,...require('./gateway-routing')};
