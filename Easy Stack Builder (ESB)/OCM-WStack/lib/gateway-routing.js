'use strict';
const net=require('node:net');
const {setTimeout:pause}=require('node:timers/promises');
const lock=require('../upstream-lock.json');
const {fail}=require('./config');
const BEGIN='{{/* ESB internal tenant routing begin */}}';
const END='{{/* ESB internal tenant routing end */}}';
const SELECTOR='gateway.envoyproxy.io/owning-gateway-name=envoy-gateway,gateway.envoyproxy.io/owning-gateway-namespace=infrastructure';
const CONTROLLER_SELECTOR='app.kubernetes.io/name=cert-manager,app.kubernetes.io/component=controller';
const defaults={now:Date.now,sleep:pause,pollMs:3000,progressMs:10000};
const mapped=(pod,host,ip)=>pod?.spec?.hostAliases?.some(a=>a.ip===ip&&a.hostnames?.includes(host))===true;

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
 const list=await r.json('kubectl',['-n','infrastructure','get','deployments','-l',CONTROLLER_SELECTOR,'-o','json']);
 if(list?.items?.length!==1||!(list.items[0].spec.replicas??1))fail('GATEWAY_ROUTING','Expected exactly one active cert-manager controller Deployment in infrastructure.');
 return list.items[0];
}
async function internalValues(r,c,values){
 if(!c.internalGatewayRouting)return values;
 const service=await publicService(r),deployment=await controller(r);
 const aliases=aliasesFor(deployment.spec.template.spec.hostAliases,c.tenantHost,service.spec.clusterIP);
 return {...values,esbTemplatePatch:routingTemplate(values.esbTemplatePatch,aliases)};
}
async function routingState(r,c,ip){
 const [deployment,list]=await Promise.all([
  controller(r),
  r.json('kubectl',['-n','infrastructure','get','pods','-l',CONTROLLER_SELECTOR,'-o','json'])
 ]);
 const desired=deployment.spec.replicas??1;
 const templateMapped=mapped(deployment.spec.template,c.tenantHost,ip);
 const rolledOut=templateMapped&&deployment.status?.observedGeneration>=deployment.metadata.generation&&deployment.status?.replicas===desired&&deployment.status?.updatedReplicas===desired&&deployment.status?.availableReplicas===desired;
 const pods=(list?.items||[]).filter(p=>!p.metadata.deletionTimestamp);
 const podStates=pods.map(p=>({name:p.metadata.name,mapped:mapped(p,c.tenantHost,ip),ready:p.status?.phase==='Running'&&p.status?.conditions?.some(x=>x.type==='Ready'&&x.status==='True')===true}));
 const ready=rolledOut&&podStates.length===desired&&podStates.every(p=>p.mapped&&p.ready);
 const message=!templateMapped?'Waiting for Argo to apply the controller host mapping':!rolledOut?'Waiting for cert-manager rollout':!ready?'Waiting for ready controller pods with the current host mapping':'Controller pods use the internal tenant route';
 return {ready,templateMapped,rolledOut,pods:podStates,message};
}
async function internalRouting(r,c,options){
 if(!c.internalGatewayRouting)return {enabled:false};
 const timing={...defaults,...options};
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
 const started=timing.now(),deadline=started+c.timeoutSeconds*1000;
 let lastProgress=-Infinity,lastState;
 while(true){
  const state=await routingState(r,c,ip),key=JSON.stringify(state);
  if(key!==lastState||timing.now()-lastProgress>=timing.progressMs){
   r.emit({type:'routing-progress',phase:'internal-tenant-routing',hostname:c.tenantHost,clusterIP:ip,service:service.metadata.name,elapsedSeconds:Math.floor((timing.now()-started)/1000),...state});
   lastState=key;lastProgress=timing.now();
  }
  if(state.ready)break;
  if(timing.now()>=deadline)fail('GATEWAY_ROUTING_TIMEOUT',state.message+'. The TLS wait has not started. Inspect the cert-manager Application, Deployment and controller pods.');
  await timing.sleep(Math.min(timing.pollMs,deadline-timing.now()),undefined,{signal:r.signal});
 }
 return {enabled:true,hostname:c.tenantHost,clusterIP:ip,service:service.metadata.name};
}
async function waitTenantTls(r,c,options){
 const timing={...defaults,...options};
 // Every caller must establish the route here; no earlier phase may silently skip it.
 await internalRouting(r,c,timing);
 const name=c.tenantRelease+'-xfsc-tenant-gateway',started=timing.now(),deadline=started+c.timeoutSeconds*1000;
 let lastProgress=-Infinity,lastState;
 r.emit({type:'phase',phase:'tenant-tls',hostname:c.tenantHost,routingMode:c.internalGatewayRouting?'internal':'public'});
 while(true){
  const [certificate,listener,service,challenges]=await Promise.all([
   r.json('kubectl',['-n','ocm-wstack','get','certificate',name,'--ignore-not-found','-o','json']),
   r.json('kubectl',['-n','ocm-wstack','get','listenerset',name,'--ignore-not-found','-o','json']),
   publicService(r),
   r.json('kubectl',['-n','ocm-wstack','get','challenges.acme.cert-manager.io','-o','json'])
  ]);
  if(c.internalGatewayRouting&&!(await routingState(r,c,service.spec.clusterIP)).ready){
   r.emit({type:'routing-drift',hostname:c.tenantHost,clusterIP:service.spec.clusterIP,message:'The controller mapping or gateway Service changed; reconciling before continuing TLS.'});
   if(timing.now()>=deadline)fail('GATEWAY_ROUTING_TIMEOUT','The controller mapping or gateway Service kept changing during the TLS wait. Resume deploy to reconcile the current route.');
   await internalRouting(r,{...c,timeoutSeconds:Math.max(0,(deadline-timing.now())/1000)},timing);
   continue;
  }
  const ready=o=>o?.status?.conditions?.some(x=>x.type==='Ready'&&x.status==='True'&&(x.observedGeneration===undefined||x.observedGeneration===o.metadata.generation));
  const programmed=listener?.status?.conditions?.some(x=>x.type==='Programmed'&&x.status==='True'&&x.observedGeneration===listener.metadata.generation);
  const certificateReady=Boolean(ready(certificate)),listenerProgrammed=Boolean(programmed),httpsPortReady=service.spec.ports.some(p=>p.port===443);
  const matching=(challenges?.items||[]).filter(x=>x.spec?.dnsName===c.tenantHost&&!x.metadata?.deletionTimestamp).map(x=>({name:x.metadata?.name,state:x.status?.state||'pending',reason:x.status?.reason||''}));
  const reasons=matching.map(x=>x.reason).filter(Boolean).join('; ');
  const message=certificateReady&&listenerProgrammed&&httpsPortReady?'Tenant HTTPS is ready':!certificateReady?(reasons||certificate?.status?.conditions?.find(x=>x.type==='Ready')?.message||'Waiting for tenant certificate'):!listenerProgrammed?'Waiting for the tenant ListenerSet to be programmed':'Waiting for Envoy Service port 443';
  const state={certificateReady,listenerProgrammed,httpsPortReady,challenges:matching,gatewayService:service.metadata.name,clusterIP:service.spec.clusterIP,gatewayAddresses:(service.status?.loadBalancer?.ingress||[]).map(x=>x.ip||x.hostname),message};
  const key=JSON.stringify(state);
  if(key!==lastState||timing.now()-lastProgress>=timing.progressMs){
   r.emit({type:'tls-progress',phase:'tenant-tls',hostname:c.tenantHost,routingMode:c.internalGatewayRouting?'internal':'public',elapsedSeconds:Math.floor((timing.now()-started)/1000),...state});
   lastState=key;lastProgress=timing.now();
  }
  if(certificateReady&&listenerProgrammed&&httpsPortReady)return;
  if(timing.now()>=deadline)fail('TENANT_TLS_NOT_READY','Tenant HTTPS is not ready: Certificate Ready='+certificateReady+', ListenerSet Programmed='+listenerProgrammed+', Service port 443='+httpsPortReady+'. '+message+' Current public gateway address: '+(state.gatewayAddresses.join(', ')||'pending')+'. Check public DNS A/AAAA records and port 80 against this gateway. UI installation was not started.');
  await timing.sleep(Math.min(timing.pollMs,deadline-timing.now()),undefined,{signal:r.signal});
 }
}
module.exports={publicService,proxyPorts,aliasesFor,routingTemplate,internalValues,internalRouting,routingState,waitTenantTls,controller,BEGIN,END,SELECTOR};
