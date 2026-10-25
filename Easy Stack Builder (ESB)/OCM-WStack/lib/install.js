'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {Runner} = require('./runner');
const {config, resolve, fingerprint, fail, object, kubeconfigText} = require('./config');
const {adapt, networkValues} = require('./adapt');
const lock = require('../upstream-lock.json');
const {prepare}=require('./chart-check');
const {upgrade:helmUpgrade,transportFailure,delay,diagnose}=require('./api-recovery');
const {bind:bindKubeconfig,identity:kubeIdentity}=require('./kube-client');
const ocm=require('./ocm');
const gatewayConfig=require('./gateway');
const runtime=require('./runtime-install');
const tls=require('./tls');
const dashboards=require('./dashboards');
const legacy=require('./legacy-config');
const MARKER = 'esb-ocmwstack-v12';
const LEASE = 'esb-ocmwstack-v12';
const MANAGED_NS = ['observability','security','argocd','infrastructure','ocm-wstack'];

// Lease times are Kubernetes metav1.MicroTime, whose JSON parser requires
// exactly six fractional digits. Date.toISOString() supplies only three.
function leaseTime() {return new Date().toISOString().replace(/\.(\d{3})Z$/,(_,ms)=>`.${ms}000Z`);}

async function privateFile(dir,name,content) {const p=path.join(dir,name);await fs.writeFile(p,content,{mode:0o600});return p;}
async function optional(r,kind,name,ns) {return r.json('kubectl',['-n',ns,'get',kind,name,'--ignore-not-found','-o','json'],{timeout:30000});}
async function updateMarker(r,marker,data) {
  marker.data = {...marker.data,...data};
  return r.json('kubectl',['-n','kube-system','replace','-f','-','-o','json'],{input:JSON.stringify(marker)});
}
async function lease(r,id,onLost=()=>{}) {
  let doc = await optional(r,'lease',LEASE,'kube-system');
  const now=Date.now();
  if (doc?.spec?.holderIdentity && Date.parse(doc.spec.renewTime || doc.spec.acquireTime) + (doc.spec.leaseDurationSeconds||180)*1000 > now) fail('BUSY','Another ESB operation holds this cluster lease.');
  const fresh={apiVersion:'coordination.k8s.io/v1',kind:'Lease',metadata:{name:LEASE,namespace:'kube-system',...(doc?{resourceVersion:doc.metadata.resourceVersion}:{})},spec:{holderIdentity:id,leaseDurationSeconds:180,acquireTime:leaseTime(),renewTime:leaseTime()}};
  doc=await r.json('kubectl',['-n','kube-system',doc?'replace':'create','-f','-','-o','json'],{input:JSON.stringify(fresh)});
  let pending=Promise.resolve(), lost;
  const timer=setInterval(()=>{
    pending=pending.then(async()=>{
      if(lost)return;
      for(let attempt=0;attempt<3;attempt++) {
        try {
          if(attempt) {
            await delay(attempt*2000,r.signal);
            const current=await optional(r,'lease',LEASE,'kube-system');
            if(current?.spec?.holderIdentity!==id)fail('LEASE_LOST','The lease no longer belongs to this operation.');
            doc=current;
          }
          const expires=Date.parse(doc.spec.renewTime||doc.spec.acquireTime)+(doc.spec.leaseDurationSeconds||180)*1000;
          if(!Number.isFinite(expires)||expires<=Date.now()+15000)fail('LEASE_LOST','The lease cannot be renewed safely before expiry.');
          doc.spec.renewTime=leaseTime();
          doc=await r.json('kubectl',['-n','kube-system','replace','-f','-','-o','json','--request-timeout=10s'],{input:JSON.stringify(doc),timeout:12000});
          break;
        } catch(e) {if(attempt===2||!transportFailure(e))throw e;}
      }
    }).catch(e=>{lost=e;onLost();});
  },45000);timer.unref();
  return {check(){if(lost)fail('LEASE_LOST','Lost the cluster lease; stop and inspect before resuming.');}, async release(){clearInterval(timer);await pending;if(!lost){doc.spec.holderIdentity='';doc.spec.renewTime=leaseTime();await r.run('kubectl',['-n','kube-system','replace','-f','-'],{input:JSON.stringify(doc),allowFailure:true,timeout:30000});}}};
}
async function preflight(r,c,credentials) {
  await Promise.all(['bash','git','helm','kubectl','jq','curl','base64'].map(cmd => r.run('bash',['-c','command -v "$1" >/dev/null','esb-prerequisite',cmd])));
  const access=await r.run('kubectl',['auth','can-i','*','*','--all-namespaces']);
  if(access.stdout.trim()!=='yes')fail('RBAC','The supplied kubeconfig must have cluster-admin permissions.');
  const argoAccess=await r.run('kubectl',['auth','can-i','list','applications.argoproj.io','-n','argocd'],{allowFailure:true});
  if(argoAccess.stdout.trim()!=='yes')fail('RBAC','The identity authenticated by the uploaded kubeconfig cannot list Argo Applications in argocd. No installation was started. Check the kubeconfig-selection and kubeconfig-identity events.');
  const [nodes,classes,system,helm]=await Promise.all([
    r.json('kubectl',['get','nodes','-o','json']),r.json('kubectl',['get','storageclasses','-o','json']),
    r.json('kubectl',['get','namespace','kube-system','-o','json']),r.run('helm',['version','--short'])
  ]);
  if(!/^v[34]\./.test(helm.stdout.trim()))fail('HELM_VERSION','This procedure requires Helm 3 or 4.');
  if(!nodes.items?.some(n=>!n.spec?.unschedulable && n.status?.conditions?.some(x=>x.type==='Ready'&&x.status==='True')))fail('NO_READY_NODES','No schedulable Ready Kubernetes node was found.');
  const resolved=resolve(c,nodes,classes,credentials);
  let legacyFingerprint;try{legacyFingerprint=legacy.fingerprint({...legacy.resolve(legacy.config({...c,provider:c.provider==='ionos'?'auto':c.provider}),nodes,classes,credentials),clusterUid:system.metadata.uid});}catch{}
  return {...resolved,legacyFingerprint,clusterUid:system.metadata.uid};
}
async function checkout(r,dir) {
  const target=path.join(dir,'deployment');
  await r.run('git',['init','--quiet',target]);
  await r.run('git',['-C',target,'remote','add','origin',lock.repository]);
  await r.run('git',['-C',target,'fetch','--depth=1','origin',lock.commit],{timeout:300000});
  await r.run('git',['-C',target,'checkout','--quiet','--detach','FETCH_HEAD']);
  const sha=(await r.run('git',['-C',target,'rev-parse','HEAD'])).stdout.trim();
  if(sha!==lock.commit)fail('UPSTREAM_COMMIT','Downloaded source does not match the reviewed official bootstrap commit.');
  await adapt(target);
  return target;
}
function matches(marker,c){
 if(marker.data?.instance!==c.instanceName||marker.data?.clusterUid!==c.clusterUid)return false;
 if([fingerprint(c),c.legacyFingerprint].filter(Boolean).includes(marker.data?.fingerprint))return true;
 return marker.metadata?.labels?.['app.kubernetes.io/managed-by']==='esb-ocmwstack'&&marker.data.tenantId===c.tenantId&&marker.data.tenantRelease===c.tenantRelease&&marker.data.tenantHost===c.tenantHost&&(!marker.data.storageClass||marker.data.storageClass===c.actualStorageClass);
}
async function ensureMarker(r,c) {
  let marker=await optional(r,'configmap',MARKER,'kube-system');
  const digest=fingerprint(c);
  if(marker) {
    if(!matches(marker,c))fail('OWNERSHIP','The existing ownership marker does not match this cluster, tenant or storage configuration.');
    if(![lock.commit,...(lock.compatibleBootstrapCommits||[])].includes(marker.data?.upstreamCommit))fail('UPSTREAM_COMMIT','This installation uses a different bootstrap revision. A fresh cluster is required.');
    if(marker.data.fingerprint!==digest||marker.data.upstreamCommit!==lock.commit)marker=await updateMarker(r,marker,{fingerprint:digest,upstreamCommit:lock.commit,migratedFrom:marker.data.upstreamCommit,storageClass:c.actualStorageClass,packageVersion:require('../package.json').version});
    return marker;
  }
  const namespaces=await r.json('kubectl',['get','namespaces','-o','json']);
  const collisions=namespaces.items.filter(x=>MANAGED_NS.includes(x.metadata.name)).map(x=>x.metadata.name);
  if(collisions.length)fail('NOT_FRESH',`This procedure requires fresh upstream namespaces. Already present: ${collisions.join(', ')}. No existing installation has been adopted.`);
  marker={apiVersion:'v1',kind:'ConfigMap',metadata:{name:MARKER,namespace:'kube-system',labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}},data:{instance:c.instanceName,fingerprint:digest,clusterUid:c.clusterUid,upstreamCommit:lock.commit,storageClass:c.actualStorageClass,packageVersion:require('../package.json').version,state:'initializing',createdAt:new Date().toISOString(),tenantRelease:c.tenantRelease,tenantId:c.tenantId,tenantHost:c.tenantHost}};
  return r.json('kubectl',['-n','kube-system','create','-f','-','-o','json'],{input:JSON.stringify(marker)});
}
async function inspect(r,c) {
  const [apps,pods,pvcs,gateway,certificates,proxy,proxyServices,policy] = await Promise.all([
    r.json('kubectl',['-n','argocd','get','applications.argoproj.io','-o','json']),
    r.json('kubectl',['get','pods','-A','-o','json']),
    r.json('kubectl',['get','pvc','-A','-o','json']),
    optional(r,'gateway','envoy-gateway','infrastructure'),
    optional(r,'secret',tls.secretName(c),'ocm-wstack'),
    optional(r,'envoyproxy','envoy','infrastructure'),
    r.json('kubectl',['-n','infrastructure','get','services','-l','gateway.envoyproxy.io/owning-gateway-name=envoy-gateway,gateway.envoyproxy.io/owning-gateway-namespace=infrastructure','-o','json']),
    r.json('kubectl',['get','clusterpolicy','esb-ocm-envoy-traffic','--ignore-not-found','-o','json'])
  ]);
  const ownedApps=apps.items.filter(x=>x.metadata.ownerReferences?.some(o=>o.kind==='ApplicationSet'&&['storage','network','core','ocm-wstack'].includes(o.name)));
  const names=new Set(ownedApps.flatMap(x=>x.metadata.ownerReferences.filter(o=>o.kind==='ApplicationSet').map(o=>o.name)));
  const applications=ownedApps.map(x=>({name:x.metadata.name,sync:x.status?.sync?.status,health:x.status?.health?.status,revision:x.status?.sync?.revision}));
  const unhealthy=applications.filter(x=>x.sync!=='Synced'||x.health!=='Healthy');
  const addresses=(gateway?.status?.addresses||[]).map(x=>({type:x.type,value:x.value}));
  const pendingVolumes=pvcs.items.filter(x=>MANAGED_NS.includes(x.metadata.namespace)&&x.status?.phase!=='Bound').map(x=>`${x.metadata.namespace}/${x.metadata.name}`);
  const publicServices=(proxyServices?.items||[]).filter(s=>s.spec?.type==='LoadBalancer');
  const proxyConfig=proxy?.spec?.provider?.kubernetes?.envoyService;
  const foreignKeys=a=>c.actualProvider==='hetzner'?[]:Object.keys(a||{}).filter(k=>k.startsWith('load-balancer.hetzner.cloud/'));
  const mapped=p=>p?.spec?.hostAliases?.some(a=>a.ip===publicServices[0]?.spec.clusterIP&&a.hostnames?.includes(c.tenantHost));
  const certManagerMapped=pods.items.some(p=>p.metadata.namespace==='infrastructure'&&p.metadata.labels?.['app.kubernetes.io/component']==='controller'&&p.metadata.labels?.['app.kubernetes.io/name']==='cert-manager'&&mapped(p));
  const runtimeMapped=!c.runtimeEnabled||pods.items.some(p=>p.metadata.namespace==='ocm-wstack'&&p.metadata.labels?.app==='ocm-orce'&&mapped(p));
  const internalRoutingReady=!c.internalGatewayRouting||runtimeMapped;
  const gatewayConfigurationReady=internalRoutingReady&&proxyConfig?.externalTrafficPolicy===c.externalTrafficPolicy&&foreignKeys(proxyConfig.annotations).length===0&&policy?.status?.conditions?.some(x=>x.type==='Ready'&&x.status==='True')&&publicServices.length>0&&publicServices.every(s=>s.spec.externalTrafficPolicy===c.externalTrafficPolicy&&foreignKeys(s.metadata.annotations).length===0&&[80,443].every(p=>s.spec.ports?.some(x=>x.port===p)));
  const certReady=tls.ready(certificates,c.tenantHost);
  const managedPods=pods.items.filter(x=>MANAGED_NS.includes(x.metadata.namespace)&&!x.metadata.deletionTimestamp);
  const podsReady=managedPods.some(x=>x.metadata.namespace==='ocm-wstack')&&managedPods.every(x=>x.status?.phase==='Succeeded'||(x.status?.phase==='Running'&&x.status?.containerStatuses?.length&&x.status.containerStatuses.every(s=>s.ready)));
  return {upstreamCommit:lock.commit,argoRevision:lock.argoRevision,tenantId:c.tenantId,tenantUrl:c.tenantUrl,provider:c.actualProvider,providerLocations:c.providerLocations,externalTrafficPolicy:c.externalTrafficPolicy,storageClass:c.actualStorageClass,ui:c.runtimeEnabled?{enabled:true,url:c.tenantUrl+'/orce/',editorUrl:c.tenantUrl+'/orce/editor/'}:{enabled:false},
    applications,gatewayAddresses:addresses,pendingVolumes,certificateReady:certReady,gatewayConfigurationReady:Boolean(gatewayConfigurationReady),gatewayConfiguration:{tenantRouting:{mode:c.internalGatewayRouting?'internal':'public',hostname:c.tenantHost,clusterIP:publicServices[0]?.spec.clusterIP,certManagerMapped,runtimeMapped,ready:internalRoutingReady},expectedTrafficPolicy:c.externalTrafficPolicy,proxyTrafficPolicy:proxyConfig?.externalTrafficPolicy,foreignAnnotationKeys:foreignKeys(proxyConfig?.annotations),admissionPolicyReady:Boolean(policy?.status?.conditions?.some(x=>x.type==='Ready'&&x.status==='True')),services:publicServices.map(s=>({name:s.metadata.name,externalTrafficPolicy:s.spec.externalTrafficPolicy,ports:s.spec.ports.map(p=>p.port),foreignAnnotationKeys:foreignKeys(s.metadata.annotations)}))},
    clusterReady:names.size===4&&unhealthy.length===0&&pendingVolumes.length===0&&podsReady&&(!c.runtimeEnabled||['ocm-orce','ocm-ui-keycloak','ocm-ui-postgres'].every(app=>managedPods.some(p=>p.metadata.labels?.app===app))),
    pods:managedPods.map(x=>({name:x.metadata.name,namespace:x.metadata.namespace,phase:x.status?.phase,containers:(x.status?.containerStatuses||[]).map(s=>({name:s.name,image:s.image,imageID:s.imageID,ready:s.ready,restarts:s.restartCount}))})),
    dns:{automatic:c.externalDns,hostname:c.tenantHost,targets:addresses.map(x=>x.value),instructions:c.externalDns?'ExternalDNS manages the tenant record.':'Point the tenant hostname'+(c.publicDashboards?', argocd.'+c.domain+' and grafana.'+c.domain:'')+' to these gateway addresses. Public TCP 443 must reach Envoy. Remove stale A/AAAA records.'}};
}
async function validate(r,c) {
  const report=await inspect(r,c);
  const {metadataChecks,request}=require('./native');
  const publicRequest=(url,options={})=>request(url,{...options,addresses:c.publicDnsRecords?.find(x=>x.hostname===new URL(url).hostname&&x.ready)?.addresses});
  report.native=await metadataChecks(c.tenantUrl,{signal:r.signal,requester:publicRequest});
  report.status=report.clusterReady&&report.certificateReady&&report.gatewayConfigurationReady&&report.native.every(x=>x.ok)?'ready':'action-required';
  if(c.runtimeEnabled){
    const realm='ocm-ui-'+c.tenantId;
    const checks=await Promise.all([['ui-ready','/orce/ui-api/v1/health/ready',d=>d?.ready===true],['ui-auth','/orce/ui-api/v1/auth/config',d=>d?.data?.issuer===c.tenantUrl+'/orce/identity/realms/'+realm&&d?.data?.clientId==='ocm-ui'],['ui-issuer','/orce/identity/realms/'+realm+'/.well-known/openid-configuration',d=>d?.issuer===c.tenantUrl+'/orce/identity/realms/'+realm]].map(async([name,url,check])=>{try{const response=await publicRequest(c.tenantUrl+url,{signal:r.signal});return {name,httpStatus:response.status,ok:response.ok&&check(response.data),...(name==='ui-ready'?{nativeReady:response.data?.nativeReady===true,dependencies:response.data?.dependencies||[]}: {})};}catch{return {name,ok:false};}}));
    checks.push(...await require('./api-check').checks(c.tenantUrl,{requester:publicRequest,signal:r.signal}));
    report.ui={...report.ui,checks};if(checks.some(x=>!x.ok)||checks.find(x=>x.name==='ui-ready')?.nativeReady!==true)report.status='action-required';
  }
  if(c.publicDashboards){
    const checks=await Promise.all([['argocd',`https://argocd.${c.domain}/api/version`,d=>typeof (d?.Version||d?.version)==='string'],['grafana',`https://grafana.${c.domain}/api/health`,d=>d?.database==='ok']].map(async([name,url,check])=>{try{const result=await publicRequest(url,{signal:r.signal});return {name,httpStatus:result.status,ok:result.ok&&check(result.data)};}catch{return {name,ok:false};}}));
    report.dashboards={public:true,checks};if(checks.some(x=>!x.ok))report.status='action-required';
  }
  report.credentialLifecycle='not-tested';
  report.internetVerified=report.native.every(x=>x.ok)&&(!c.runtimeEnabled||report.ui.checks.every(x=>x.ok))&&(!c.publicDashboards||report.dashboards.checks.every(x=>x.ok));
  return report;
}
async function waitValidation(r,c,{check=validate,now=Date.now,pause=delay}={}){
  const started=now(),budget=Math.min(c.timeoutSeconds,300)*1000;
  while(true){
    const report=await check(r,c);
    const dependencies=report.ui?.checks?.find(x=>x.name==='ui-ready')?.dependencies||[];
    // A native contract rejection is actionable; waiting cannot repair it.
    const rejected=dependencies.some(x=>x.ok===false&&x.httpStatus>=400&&x.httpStatus<500);
    r.emit({type:'validation-progress',phase:'native-validation',elapsedSeconds:Math.floor((now()-started)/1000),status:report.status,internetVerified:report.internetVerified,dependencies});
    if(report.status==='ready'||rejected||now()-started>=budget)return report;
    await pause(Math.min(5000,Math.max(0,budget-(now()-started))),r.signal);
  }
}
async function operation(action,input,credentials,{emit=()=>{},signal:externalSignal,runnerFactory,checkoutSource=checkout}={}) {
  if(!['deploy','repair-ocm','repair-network','install-ui','preflight','diagnose-api','diagnose-auth','validate','inspect','test-credentials','teardown'].includes(action))fail('ACTION','Use deploy, repair-ocm, repair-network, install-ui, preflight, diagnose-api, diagnose-auth, validate, inspect, test-credentials or teardown.');
  const controller=new AbortController();
  const relay=()=>controller.abort();
  if(externalSignal?.aborted)controller.abort();
  externalSignal?.addEventListener('abort',relay,{once:true});
  const signal=controller.signal;
  const c0=config(input);
  const kubeText=kubeconfigText(credentials?.kubeconfig);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-ocmwstack-'));await fs.chmod(dir,0o700);
  let held,marker,c,r,dnsTimer,observerClosed=false,certificate;
  try {
    const kubeconfig=await privateFile(dir,'kubeconfig',kubeText);
    const env={...process.env,KUBECONFIG:kubeconfig,GIT_TERMINAL_PROMPT:'0',HELM_QPS:'5',HELM_BURST_LIMIT:'10',HELM_CACHE_HOME:path.join(dir,'helm/cache'),HELM_CONFIG_HOME:path.join(dir,'helm/config'),HELM_DATA_HOME:path.join(dir,'helm/data')};
    const secrets=[credentials.kubeconfig,kubeText,credentials.dnsToken,credentials.editorPassword,credentials.uiAdminPassword,credentials.mongoUri,credentials.tlsPrivateKey,...Object.values(object(credentials.dnsSecretData,'DNS Secret data'))];
    r=runnerFactory?runnerFactory({cwd:dir,env,emit,secrets,signal}):new Runner({cwd:dir,env,emit,secrets,signal});
    const selected=await bindKubeconfig(r,dir,kubeconfig,kubeText);
    if(action==='diagnose-auth')return {status:'authentication-checked',...selected,identity:await kubeIdentity(r)};
    if(action==='diagnose-api')return await diagnose(r);
    await kubeIdentity(r);
    emit({type:'phase',phase:'preflight'});c=await preflight(r,c0,credentials);
    const priorMarker=await optional(r,'configmap',MARKER,'kube-system');c.dnsOwnerId=priorMarker?(priorMarker.data?.dnsOwnerId||'xfsc'):'esb-'+c.clusterUid;
    emit({type:'detected',provider:c.actualProvider,detectedProvider:c.detectedProvider,storageClass:c.actualStorageClass,dnsProvider:c.actualDns,locations:c.providerLocations,zones:c.providerZones,providerEvidence:c.providerEvidence,externalTrafficPolicy:c.externalTrafficPolicy,upstreamCommit:lock.commit});
    if(action==='inspect'||action==='validate')return action==='validate'?await validate(r,c):await inspect(r,c);
    if(action==='test-credentials') {
      if(input.confirm!=='CREATE TEST CREDENTIAL')fail('CONFIRM','Native testing creates and accepts an Ada Lovelace credential. Set msg.confirm = "CREATE TEST CREDENTIAL".');
      await require('./storage-scope').discover(r,c);
      const {tunnel}=require('./tunnel');
      const {exercise}=require('./native');
      let retrieval,storage;
      try {
        retrieval=await tunnel('credential-retrieval-service',r.env,signal);
        storage=await tunnel('storage-service',r.env,signal);
        return await exercise(c,{retrieval:retrieval.url,storage:storage.url,emit,signal});
      } finally {if(storage)await storage.close();if(retrieval)await retrieval.close();}
    }
    if(action==='teardown') {
      if(input.confirm!==`REMOVE TENANT ${c.tenantRelease}`)fail('CONFIRM','Explicit teardown requires msg.confirm = "REMOVE TENANT '+c.tenantRelease+'".');
      marker=await optional(r,'configmap',MARKER,'kube-system');
      if(!marker || marker.data?.instance!==c.instanceName || marker.data?.tenantRelease!==c.tenantRelease || marker.data?.clusterUid!==c.clusterUid)fail('OWNERSHIP','Tenant teardown requires this instance’s ownership marker.');
      held=await lease(r,crypto.randomUUID(),()=>controller.abort());
      await r.run('helm',['uninstall',c.tenantRelease,'-n','ocm-wstack','--ignore-not-found','--timeout',`${c.timeoutSeconds}s`],{timeout:(c.timeoutSeconds+30)*1000,live:true});
      marker=await updateMarker(r,marker,{state:'tenant-removed',updatedAt:new Date().toISOString()});
      return {status:'tenant-removed',tenantRelease:c.tenantRelease,retained:['OCM services','Argo CD','shared infrastructure','credential data','OpenBao tenant keys','signer registration']};
    }
    // Parse and validate all certificate material before any cluster mutation.
    certificate=tls.configuration(c,credentials);
    r.secrets.push(certificate.privateKey,Buffer.from(certificate.privateKey).toString('base64'));
    await dashboards.preflight(r,c,credentials);
    // Source and adaptation checks precede writes to the cluster.
    emit({type:'phase',phase:'upstream-source'});
    if(c.runtimeEnabled&&['deploy','repair-ocm','install-ui','preflight'].includes(action))await runtime.preflight(r,c,credentials);
    const source=await checkoutSource(r,dir);
    const chartReport=await prepare(r,source,c,dir);
    if(action==='preflight')return chartReport;
    if(['repair-ocm','repair-network','install-ui'].includes(action)) {
      const existing=await optional(r,'configmap',MARKER,'kube-system');
      if(!existing)fail('OWNERSHIP','repair-ocm requires the existing matching ESB installation marker. Use deploy for a fresh cluster.');
      if(!matches(existing,c)||![lock.commit,...(lock.compatibleBootstrapCommits||[])].includes(existing.data?.upstreamCommit))fail('OWNERSHIP','repair-ocm requires the original ESB configuration and bootstrap revision.');
    }
    const holder=crypto.randomUUID();
    held=await lease(r,holder,()=>controller.abort());
    r.env={...r.env,ESB_LEASE_HOLDER:holder,ESB_HELM_UPGRADE:path.join(__dirname,'../scripts/helm-upgrade.js'),ESB_KUBE_READ:path.join(__dirname,'../scripts/kube-read.js'),ESB_ARGO_HEALTH:path.join(__dirname,'../scripts/argo-health.js'),ESB_OCM_PREREQUISITES:path.join(__dirname,'../scripts/ocm-prerequisites.js'),ESB_GATEWAY_CONFIG:path.join(__dirname,'../scripts/gateway-config.js')};
    marker=await ensureMarker(r,c);
    marker=await updateMarker(r,marker,{dnsOwnerId:c.dnsOwnerId,validatedArgoRevision:chartReport.argoRevision,validatedChartCount:String(chartReport.charts.length),argoManifestSha256:chartReport.argoManifestSha256});
    const gatewayValues=await privateFile(dir,'gateway-values.json',JSON.stringify({externalTrafficPolicy:c.externalTrafficPolicy,timeoutSeconds:c.timeoutSeconds,tenantHost:c.tenantHost,tlsMode:c.tlsMode,gatewayRouting:c.gatewayRouting,internalGatewayRouting:c.internalGatewayRouting}));
    r.env={...r.env,ESB_GATEWAY_VALUES:gatewayValues};
    const networkConfiguration=marker.data.bootstrapComplete==='true'?await gatewayConfig.internalValues(r,c,networkValues(c)):networkValues(c);
    const network=await privateFile(dir,'network-values.json',JSON.stringify(networkConfiguration));
    const observability=await privateFile(dir,'observability-values.json',JSON.stringify(require('./observability').values(c)));
    const coreValues=await privateFile(dir,'core-values.json',JSON.stringify(ocm.routingValues()));
    const ocmValues=await privateFile(dir,'ocm-values.json',JSON.stringify(ocm.values(c)));
    let secretFile='';
    if(c.externalDns)secretFile=await privateFile(dir,'dns-secret.json',JSON.stringify({apiVersion:'v1',kind:'Secret',metadata:{name:'external-dns',namespace:'infrastructure'},type:'Opaque',stringData:c.dnsSecret}));
    r.env={...r.env,ESB_STORAGE_CLASS:c.actualStorageClass,ESB_TIMEOUT_SECONDS:String(c.timeoutSeconds),TIMEOUT_SECONDS:String(c.timeoutSeconds),ESB_CORE_VALUES:coreValues,ESB_NETWORK_VALUES:network,ESB_OBSERVABILITY_VALUES:observability,ESB_OCM_VALUES:ocmValues,ESB_DNS_SECRET_FILE:secretFile,ESB_OCM_STARTUP:path.join(__dirname,'../scripts/ocm-startup.js'),ESB_NATIVE_DIDCOMM:String(!!(c.runtimeEnabled&&!c.runtimeServices?.didcomm))};
    if(action==='install-ui'){await tls.install(r,c,certificate);if(marker.data.bootstrapComplete!=='true')fail('OWNERSHIP','Complete the native bootstrap before install-ui.');if(!c.runtimeEnabled)fail('CONFIG','Enable the ORCE runtime before install-ui.');await gatewayConfig.internalRouting(r,c);await gatewayConfig.waitTenantTls(r,c);const ui=await runtime.install(r,c,credentials,dir);const report=await validate(r,c);return {...report,ui:{...report.ui,...ui}};}
    let lastAddresses='',observing=false;
    dnsTimer=setInterval(async()=>{
      if(observing||signal.aborted)return;
      observing=true;
      try {
        const gateway=await optional(r,'gateway','envoy-gateway','infrastructure');
        const addresses=(gateway?.status?.addresses||[]).map(x=>x.value);
        const key=JSON.stringify(addresses);
        if(!observerClosed&&addresses.length&&key!==lastAddresses){lastAddresses=key;emit({type:'dns',automatic:c.externalDns,hostname:c.tenantHost,targets:addresses});}
      } catch {} finally {observing=false;}
    },30000);dnsTimer.unref();
    if(marker.data.bootstrapComplete==='true'||action==='repair-network'){
      emit({type:'phase',phase:'gateway-compatibility'});
      await require('./dns-values').permitRepository(r,c);
      if(c.externalDns)await r.run('kubectl',['apply','-f',secretFile]);
      await gatewayConfig.policy(r,c);
      await helmUpgrade(r,['upgrade','--install','network',path.join(source,'XFSC/Applicationsets/chart'),'-f',path.join(source,'XFSC/Applicationsets/values/04_network-values.yaml'),'-f',network,'--set-string',`storageClass=${c.actualStorageClass}`,'--set-string',`profile=${c.profile}`,'--set-string',`domain=${c.domain}`,'--set-string',`email=${c.email}`,'-n','infrastructure','--timeout',`${c.timeoutSeconds}s`],{namespace:'infrastructure',release:'network',cwd:source,timeout:(c.timeoutSeconds+30)*1000});
      await r.run('bash',['check-applicationset.sh','network','argocd'],{cwd:source,timeout:(c.timeoutSeconds+30)*1000,live:true});
      await gatewayConfig.reconcile(r,c);
      if(action==='repair-network'){return await inspect(r,c);}
      for(const [name,file] of [['storage','03_storage'],['core','05_core']]){
        await helmUpgrade(r,['upgrade','--install',name,path.join(source,'XFSC/Applicationsets/chart'),'-f',path.join(source,`XFSC/Applicationsets/values/${file}-values.yaml`),...(name==='core'?['-f',coreValues]:[]),'--set-string',`tag=${lock.argoRevision}`,'--set-string',`storageClass=${c.actualStorageClass}`,'-n','infrastructure','--timeout',`${c.timeoutSeconds}s`],{namespace:'infrastructure',release:name,cwd:source,timeout:(c.timeoutSeconds+30)*1000});
        await r.run('bash',['check-applicationset.sh',name,'argocd'],{cwd:source,timeout:(c.timeoutSeconds+30)*1000,live:true});
      }
    }
    if(action==='repair-ocm'||marker.data.bootstrapComplete==='true') {
      // Require healthy shared prerequisites, then reconcile only the OCM
      // ApplicationSet. The existing infrastructure and its Helm releases stay.
      const release=await r.json('helm',['status','ocm-wstack','-n','ocm-wstack','-o','json']);
      if(!['deployed','failed'].includes(release?.info?.status))fail('HELM_PENDING','OCM release is pending or unavailable; repair stopped without changing it.');
      for(const set of ['storage','network','core'])await r.run('bash',['check-applicationset.sh',set,'argocd'],{cwd:source,timeout:(c.timeoutSeconds+30)*1000,live:true});
      emit({type:'phase',phase:'repair-ocm'});
      await ocm.prerequisites(r,c.timeoutSeconds);
      await helmUpgrade(r,['upgrade','--install','ocm-wstack',path.join(source,'XFSC/Applicationsets/chart'),'-f',path.join(source,'XFSC/Applicationsets/values/06_ocm_wstack-values.yaml'),'-f',ocmValues,'--set-string',`storageClass=${c.actualStorageClass}`,'-n','ocm-wstack','--timeout',`${c.timeoutSeconds}s`],{namespace:'ocm-wstack',release:'ocm-wstack',cwd:source,timeout:(c.timeoutSeconds+30)*1000});
      await require('./ocm-startup').stabilize(r,c);
      await r.run('bash',['check-applicationset.sh','ocm-wstack','argocd'],{cwd:source,timeout:(c.timeoutSeconds+30)*1000,live:true});
      held.check();marker=await updateMarker(r,marker,{bootstrapComplete:'true',ocmCompatibility:'12.0.8',state:'tenant',updatedAt:new Date().toISOString()});
    } else if(marker.data.bootstrapComplete!=='true') {
      marker=await updateMarker(r,marker,{state:'bootstrapping',updatedAt:new Date().toISOString()});
      const args=['ocm-wstack-init.sh','--profile',c.profile,'--domain',c.domain,'--email',c.email];
      if(!c.externalDns)args.push('--disable-external-dns');
      await r.run('bash',args,{cwd:source,timeout:Math.min(c.timeoutSeconds*12,86400)*1000,live:true});
      held.check();marker=await updateMarker(r,marker,{bootstrapComplete:'true',ocmCompatibility:'12.0.8',state:'tenant',updatedAt:new Date().toISOString()});
    }
    await gatewayConfig.nativeRouting(r,c);
    emit({type:'phase',phase:'tenant'});
    await tls.install(r,c,certificate);
    const tenant=await privateFile(dir,'tenant-values.json',JSON.stringify(c.tenantValues));
    await helmUpgrade(r,['upgrade','--install',c.tenantRelease,path.join(source,'XFSC/tenant/chart'),'-f',path.join(source,'XFSC/tenant/values/tenant-ocm-wstack-values.yaml'),'-f',tenant,'-n','ocm-wstack','--timeout',`${c.timeoutSeconds}s`],{namespace:'ocm-wstack',release:c.tenantRelease,cwd:source,timeout:(c.timeoutSeconds+30)*1000});
    held.check();marker=await updateMarker(r,marker,{state:'installed',updatedAt:new Date().toISOString()});
    await gatewayConfig.internalRouting(r,c);
    await gatewayConfig.waitTenantTls(r,c);
    const ui=await runtime.install(r,c,credentials,dir);
    const admin=await dashboards.install(r,c,credentials,certificate,dir);
    c.publicDnsRecords=await require('./connectivity').waitDns(r,c);
    emit({type:'phase',phase:'native-validation'});
    const report=await waitValidation(r,c);report.ui={...report.ui,...ui};report.dashboards={...report.dashboards,...admin};
    if(/STORAGE_(REGION|COUNTRY)_MISSING/.test(JSON.stringify(report))){
      try{report.storageDiagnostics=await require('./storage-diagnostics').diagnose(r);emit({type:'storage-diagnostics',...report.storageDiagnostics});}
      catch(e){emit({type:'storage-diagnostics',error:e.code||'DIAGNOSTIC_FAILED'});}
    }
    marker=await updateMarker(r,marker,{state:report.status,updatedAt:new Date().toISOString()});
    return report;
  } catch(e) {
    const recoveryCode=/\[(API_TRANSPORT|HELM_PENDING|HELM_STATE_UNAVAILABLE|LEASE_LOST)\]/.exec(e.commandOutput||'');
    if(recoveryCode)e.code=recoveryCode[1];
    if(marker&&r&&!signal?.aborted)try{await updateMarker(r,marker,{state:'failed',lastErrorCode:e.code||'ERROR',updatedAt:new Date().toISOString()});}catch{}
    throw e;
  } finally {
    observerClosed=true;
    clearInterval(dnsTimer);
    if(held)try{await held.release();}catch{}
    externalSignal?.removeEventListener('abort',relay);
    await fs.rm(dir,{recursive:true,force:true});
  }
}
module.exports = {operation,preflight,checkout,ensureMarker,inspect,validate,waitValidation,lease,privateFile,MARKER,matches};
