'use strict';
const net=require('node:net');
const {setTimeout:pause}=require('node:timers/promises');
const lock=require('../upstream-lock.json');
const {fail}=require('./config');
const BEGIN='{{/* ESB internal tenant routing begin */}}';
const END='{{/* ESB internal tenant routing end */}}';
const SELECTOR='gateway.envoyproxy.io/owning-gateway-name=envoy-gateway,gateway.envoyproxy.io/owning-gateway-namespace=infrastructure';

async function publicService(r){
 const list=await r.json('kubectl',['-n','infrastructure','get','services','-l',SELECTOR,'-o','json']);
 const services=(list?.items||[]).filter(s=>s.spec?.type==='LoadBalancer'&&s.spec.ports?.some(p=>p.port===80));
 if(services.length!==1||!net.isIP(services[0].spec.clusterIP||''))fail('GATEWAY_ROUTING','Expected exactly one Envoy proxy LoadBalancer Service with a usable ClusterIP.');
 return services[0];
}
async function proxyPorts(r,service){
 const ports=new Set((service.spec.ports||[]).map(p=>p.port));
 for(const p of service.spec.ports||[])if(typeof p.targetPort==='number')ports.add(p.targetPort);
 if(service.spec.ports?.some(p=>typeof p.targetPort==='string')){
  const slices=await r.json('kubectl',['-n','infrastructure','get','endpointslices','-l','kubernetes.io/service-name='+service.metadata.name,'-o','json']);
  for(const slice of slices?.items||[])for(const p of slice.ports||[])if(typeof p.port==='number')ports.add(p.port);
  if(!(slices?.items||[]).some(s=>s.ports?.some(p=>typeof p.port==='number')))fail('GATEWAY_ROUTING','Named Envoy Service target ports could not be resolved from EndpointSlices.');
 }
 return [...ports].sort((a,b)=>a-b);
}
function aliasesFor(previous,host,ip){
 if(!net.isIP(ip)||typeof host!=='string'||!/^[a-z0-9.-]+$/.test(host))fail('GATEWAY_ROUTING','Invalid internal tenant routing address.');
 const aliases=(previous||[]).map(a=>({...a,hostnames:(a.hostnames||[]).filter(h=>h!==host)})).filter(a=>a.hostnames.length);
 const same=aliases.find(a=>a.ip===ip);
 if(same)same.hostnames.push(host);else aliases.push({ip,hostnames:[host]});
 return aliases;
}
function routingTemplate(previous,aliases){
 let base=previous||'';
 const start=base.indexOf(BEGIN),end=base.indexOf(END);
 if(start>=0||end>=0){
  if(start<0||end<start||base.indexOf(BEGIN,start+BEGIN.length)>=0)fail('GATEWAY_ROUTING','The managed internal routing block is malformed.');
  base=base.slice(0,start)+base.slice(end+END.length);
 }
 if(base.includes('INFRA/network/cert-manager'))fail('GATEWAY_ROUTING','A custom cert-manager template override already exists; merge its hostAliases explicitly instead of replacing it.');
 const values={'cert-manager':{hostAliases:aliases}};
 return base.trimEnd()+'\n'+BEGIN+'\n{{ if eq .path.path "INFRA/network/cert-manager" }}\nspec:\n  source:\n    helm:\n      valuesObject: null\n      values: {{ '+JSON.stringify(JSON.stringify(JSON.stringify(values)))+' }}\n{{ end }}\n'+END+'\n';
}
async function controller(r){
 const list=await r.json('kubectl',['-n','infrastructure','get','deployments','-l','app.kubernetes.io/name=cert-manager,app.kubernetes.io/component=controller','-o','json']);
 if(list?.items?.length!==1||!(list.items[0].spec.replicas??1))fail('GATEWAY_ROUTING','Expected exactly one active cert-manager controller Deployment in infrastructure.');
 return list.items[0];
}
async function internalValues(r,c,values){
 if(!c.internalGatewayRouting)return values;
 const service=await publicService(r),deployment=await controller(r);
 const aliases=aliasesFor(deployment.spec.template.spec.hostAliases,c.tenantHost,service.spec.clusterIP);
 return {...values,esbTemplatePatch:routingTemplate(values.esbTemplatePatch,aliases)};
}
async function internalRouting(r,c){
 if(!c.internalGatewayRouting)return {enabled:false};
 const service=await publicService(r),deployment=await controller(r);
 const ip=service.spec.clusterIP,aliases=aliasesFor(deployment.spec.template.spec.hostAliases,c.tenantHost,ip);
 const appset=await r.json('kubectl',['-n','argocd','get','applicationset','network','-o','json']);
 if(appset.spec?.template?.spec?.source?.repoURL!==lock.repository)fail('GATEWAY_ROUTING','Network ApplicationSet does not use the reviewed deployment repository.');
 const patch=routingTemplate(appset.spec.templatePatch,aliases);
 if(appset.spec.templatePatch!==patch)await r.run('kubectl',['-n','argocd','patch','applicationset','network','--type=json','-p',JSON.stringify([
  {op:'test',path:'/metadata/resourceVersion',value:appset.metadata.resourceVersion},
  {op:'add',path:'/spec/templatePatch',value:patch}
 ])]);
 r.emit({type:'phase',phase:'internal-tenant-routing',hostname:c.tenantHost,service:'infrastructure/'+service.metadata.name,clusterIP:ip});
 const deadline=Date.now()+c.timeoutSeconds*1000;
 while(true){
  const current=await controller(r);
  if(current.spec.template.spec.hostAliases?.some(a=>a.ip===ip&&a.hostnames?.includes(c.tenantHost))&&current.status?.observedGeneration>=current.metadata.generation&&current.status?.replicas===(current.spec.replicas??1)&&current.status?.updatedReplicas===(current.spec.replicas??1)&&current.status?.availableReplicas===(current.spec.replicas??1))break;
  if(Date.now()>=deadline)fail('GATEWAY_ROUTING_TIMEOUT','Argo has not rolled out the cert-manager tenant host mapping. Inspect the cert-manager Application and Deployment.');
  await pause(3000,undefined,{signal:r.signal});
 }
 return {enabled:true,hostname:c.tenantHost,clusterIP:ip,service:service.metadata.name};
}
async function waitTenantTls(r,c){
 const name=c.tenantRelease+'-xfsc-tenant-gateway',deadline=Date.now()+c.timeoutSeconds*1000;
 r.emit({type:'phase',phase:'tenant-tls'});
 while(true){
  const [certificate,listener,service]=await Promise.all([
   r.json('kubectl',['-n','ocm-wstack','get','certificate',name,'--ignore-not-found','-o','json']),
   r.json('kubectl',['-n','ocm-wstack','get','listenerset',name,'--ignore-not-found','-o','json']),
   publicService(r)
  ]);
  const ready=o=>o?.status?.conditions?.some(x=>x.type==='Ready'&&x.status==='True'&&(x.observedGeneration===undefined||x.observedGeneration===o.metadata.generation));
  const programmed=listener?.status?.conditions?.some(x=>x.type==='Programmed'&&x.status==='True'&&x.observedGeneration===listener.metadata.generation);
  if(ready(certificate)&&programmed&&service.spec.ports.some(p=>p.port===443))return;
  if(Date.now()>=deadline){
   const challenges=await r.json('kubectl',['-n','ocm-wstack','get','challenges.acme.cert-manager.io','-o','json']);
   const matching=(challenges?.items||[]).filter(x=>x.spec?.dnsName===c.tenantHost);
   const reasons=matching.map(x=>x.status?.reason).filter(Boolean).join('; ');
   fail('TENANT_TLS_NOT_READY','Tenant HTTPS is not ready: Certificate Ready='+Boolean(ready(certificate))+', ListenerSet Programmed='+Boolean(programmed)+', Service port 443='+service.spec.ports.some(p=>p.port===443)+'. '+reasons+' UI installation was not started.');
  }
  await pause(3000,undefined,{signal:r.signal});
 }
}
module.exports={publicService,proxyPorts,aliasesFor,routingTemplate,internalValues,internalRouting,waitTenantTls,controller,BEGIN,END,SELECTOR};
