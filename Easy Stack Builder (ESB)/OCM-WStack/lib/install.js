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
  const [nodes,classes,system,helm]=await Promise.all([
    r.json('kubectl',['get','nodes','-o','json']),r.json('kubectl',['get','storageclasses','-o','json']),
    r.json('kubectl',['get','namespace','kube-system','-o','json']),r.run('helm',['version','--short'])
  ]);
  if(!/^v3\./.test(helm.stdout.trim()))fail('HELM_VERSION','This reviewed procedure requires Helm 3.');
  if(!nodes.items?.some(n=>!n.spec?.unschedulable && n.status?.conditions?.some(x=>x.type==='Ready'&&x.status==='True')))fail('NO_READY_NODES','No schedulable Ready Kubernetes node was found.');
  return {...resolve(c,nodes,classes,credentials),clusterUid:system.metadata.uid};
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
async function ensureMarker(r,c) {
  let marker=await optional(r,'configmap',MARKER,'kube-system');
  const digest=fingerprint(c);
  if(marker) {
    if(marker.data?.instance!==c.instanceName || marker.data?.fingerprint!==digest || marker.data?.clusterUid!==c.clusterUid)fail('OWNERSHIP','This cluster has an ESB installation with different settings. Restore its original configuration; this release only supports fresh installs and exact-configuration resumes.');
    if(marker.data?.upstreamCommit!==lock.commit)fail('UPSTREAM_COMMIT','This installation uses a different bootstrap revision. A fresh cluster is required.');
    return marker;
  }
  const namespaces=await r.json('kubectl',['get','namespaces','-o','json']);
  const collisions=namespaces.items.filter(x=>MANAGED_NS.includes(x.metadata.name)).map(x=>x.metadata.name);
  if(collisions.length)fail('NOT_FRESH',`This procedure requires fresh upstream namespaces. Already present: ${collisions.join(', ')}. No existing installation has been adopted.`);
  marker={apiVersion:'v1',kind:'ConfigMap',metadata:{name:MARKER,namespace:'kube-system',labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}},data:{instance:c.instanceName,fingerprint:digest,clusterUid:c.clusterUid,upstreamCommit:lock.commit,state:'initializing',createdAt:new Date().toISOString(),tenantRelease:c.tenantRelease,tenantId:c.tenantId,tenantHost:c.tenantHost}};
  return r.json('kubectl',['-n','kube-system','create','-f','-','-o','json'],{input:JSON.stringify(marker)});
}
async function inspect(r,c) {
  const [apps,pods,pvcs,gateway,certificates] = await Promise.all([
    r.json('kubectl',['-n','argocd','get','applications.argoproj.io','-o','json']),
    r.json('kubectl',['get','pods','-A','-o','json']),
    r.json('kubectl',['get','pvc','-A','-o','json']),
    optional(r,'gateway','envoy-gateway','infrastructure'),
    r.json('kubectl',['-n','ocm-wstack','get','certificates','-l',`app.kubernetes.io/instance=${c.tenantRelease}`,'-o','json'])
  ]);
  const ownedApps=apps.items.filter(x=>x.metadata.ownerReferences?.some(o=>o.kind==='ApplicationSet'&&['storage','network','core','ocm-wstack'].includes(o.name)));
  const names=new Set(ownedApps.flatMap(x=>x.metadata.ownerReferences.filter(o=>o.kind==='ApplicationSet').map(o=>o.name)));
  const applications=ownedApps.map(x=>({name:x.metadata.name,sync:x.status?.sync?.status,health:x.status?.health?.status,revision:x.status?.sync?.revision}));
  const unhealthy=applications.filter(x=>x.sync!=='Synced'||x.health!=='Healthy');
  const addresses=(gateway?.status?.addresses||[]).map(x=>({type:x.type,value:x.value}));
  const pendingVolumes=pvcs.items.filter(x=>MANAGED_NS.includes(x.metadata.namespace)&&x.status?.phase!=='Bound').map(x=>`${x.metadata.namespace}/${x.metadata.name}`);
  const certReady=certificates.items.length>0&&certificates.items.every(x=>x.status?.conditions?.some(q=>q.type==='Ready'&&q.status==='True'));
  const managedPods=pods.items.filter(x=>MANAGED_NS.includes(x.metadata.namespace));
  const podsReady=managedPods.some(x=>x.metadata.namespace==='ocm-wstack')&&managedPods.every(x=>x.status?.phase==='Succeeded'||(x.status?.phase==='Running'&&x.status?.containerStatuses?.length&&x.status.containerStatuses.every(s=>s.ready)));
  return {upstreamCommit:lock.commit,argoRevision:'main',tenantId:c.tenantId,tenantUrl:c.tenantUrl,provider:c.actualProvider,storageClass:c.actualStorageClass,
    applications,gatewayAddresses:addresses,pendingVolumes,certificateReady:certReady,
    clusterReady:names.size===4&&unhealthy.length===0&&pendingVolumes.length===0&&podsReady,
    pods:managedPods.map(x=>({name:x.metadata.name,namespace:x.metadata.namespace,phase:x.status?.phase,containers:(x.status?.containerStatuses||[]).map(s=>({name:s.name,image:s.image,imageID:s.imageID,ready:s.ready,restarts:s.restartCount}))})),
    dns:{automatic:c.externalDns,hostname:c.tenantHost,targets:addresses.map(x=>x.value),instructions:c.externalDns?'ExternalDNS manages the tenant record.':'Point this tenant hostname to the gateway addresses (A/AAAA for IPs, CNAME for an LB hostname). Public TCP 80 and 443 must reach Envoy for ACME HTTP-01 and HTTPS.'}};
}
async function validate(r,c) {
  const report=await inspect(r,c);
  const {metadataChecks}=require('./native');
  report.native=await metadataChecks(c.tenantUrl,{signal:r.signal});
  report.status=report.clusterReady&&report.certificateReady&&report.native.every(x=>x.ok)?'ready':'action-required';
  report.credentialLifecycle='not-tested';
  return report;
}
async function operation(action,input,credentials,{emit=()=>{},signal:externalSignal,runnerFactory,checkoutSource=checkout}={}) {
  if(!['deploy','preflight','diagnose-api','validate','inspect','test-credentials','teardown'].includes(action))fail('ACTION','Use deploy, preflight, diagnose-api, validate, inspect, test-credentials or teardown.');
  const controller=new AbortController();
  const relay=()=>controller.abort();
  if(externalSignal?.aborted)controller.abort();
  externalSignal?.addEventListener('abort',relay,{once:true});
  const signal=controller.signal;
  const c0=config(input);
  const kubeText=kubeconfigText(credentials?.kubeconfig);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-ocmwstack-'));await fs.chmod(dir,0o700);
  let held,marker,c,r,dnsTimer,observerClosed=false;
  try {
    const kubeconfig=await privateFile(dir,'kubeconfig',kubeText);
    const env={...process.env,KUBECONFIG:kubeconfig,GIT_TERMINAL_PROMPT:'0',HELM_QPS:'5',HELM_BURST_LIMIT:'10',HELM_CACHE_HOME:path.join(dir,'helm/cache'),HELM_CONFIG_HOME:path.join(dir,'helm/config'),HELM_DATA_HOME:path.join(dir,'helm/data')};
    const secrets=[credentials.kubeconfig,kubeText,credentials.dnsToken,...Object.values(object(credentials.dnsSecretData,'DNS Secret data'))];
    r=runnerFactory?runnerFactory({cwd:dir,env,emit,secrets,signal}):new Runner({cwd:dir,env,emit,secrets,signal});
    if(action==='diagnose-api')return await diagnose(r);
    emit({type:'phase',phase:'preflight'});c=await preflight(r,c0,credentials);
    emit({type:'detected',provider:c.actualProvider,detectedProvider:c.detectedProvider,storageClass:c.actualStorageClass,dnsProvider:c.actualDns,upstreamCommit:lock.commit});
    if(action==='inspect'||action==='validate')return action==='validate'?await validate(r,c):await inspect(r,c);
    if(action==='test-credentials') {
      if(input.confirm!=='CREATE TEST CREDENTIAL')fail('CONFIRM','Native testing creates and accepts an Ada Lovelace credential. Set msg.confirm = "CREATE TEST CREDENTIAL".');
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
    // Source and adaptation checks precede writes to the cluster.
    emit({type:'phase',phase:'upstream-source'});
    const source=await checkoutSource(r,dir);
    const chartReport=await prepare(r,source,c,dir);
    if(action==='preflight')return chartReport;
    const holder=crypto.randomUUID();
    held=await lease(r,holder,()=>controller.abort());
    r.env={...r.env,ESB_LEASE_HOLDER:holder,ESB_HELM_UPGRADE:path.join(__dirname,'../scripts/helm-upgrade.js'),ESB_KUBE_READ:path.join(__dirname,'../scripts/kube-read.js'),ESB_ARGO_HEALTH:path.join(__dirname,'../scripts/argo-health.js')};
    marker=await ensureMarker(r,c);
    marker=await updateMarker(r,marker,{validatedArgoRevision:chartReport.argoRevision,validatedChartCount:String(chartReport.charts.length),argoManifestSha256:chartReport.argoManifestSha256});
    const network=await privateFile(dir,'network-values.json',JSON.stringify(networkValues(c)));
    let secretFile='';
    if(c.externalDns)secretFile=await privateFile(dir,'dns-secret.json',JSON.stringify({apiVersion:'v1',kind:'Secret',metadata:{name:'external-dns',namespace:'infrastructure'},type:'Opaque',stringData:c.dnsSecret}));
    r.env={...r.env,ESB_STORAGE_CLASS:c.actualStorageClass,ESB_TIMEOUT_SECONDS:String(c.timeoutSeconds),TIMEOUT_SECONDS:String(c.timeoutSeconds),ESB_NETWORK_VALUES:network,ESB_DNS_SECRET_FILE:secretFile};
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
    if(marker.data.bootstrapComplete!=='true') {
      marker=await updateMarker(r,marker,{state:'bootstrapping',updatedAt:new Date().toISOString()});
      const args=['ocm-wstack-init.sh','--profile',c.profile,'--domain',c.domain,'--email',c.email];
      if(!c.externalDns)args.push('--disable-external-dns');
      await r.run('bash',args,{cwd:source,timeout:Math.min(c.timeoutSeconds*12,86400)*1000,live:true});
      held.check();marker=await updateMarker(r,marker,{bootstrapComplete:'true',state:'tenant',updatedAt:new Date().toISOString()});
    }
    emit({type:'phase',phase:'tenant'});
    const tenant=await privateFile(dir,'tenant-values.json',JSON.stringify({tenant:{domain:c.domain,id:c.tenantId,group:c.tenantId,subdomain:c.tenantSubdomain},openbao:{transit:{mountPath:`ocm-wstack/${c.tenantId}`}}}));
    await helmUpgrade(r,['upgrade','--install',c.tenantRelease,path.join(source,'XFSC/tenant/chart'),'-f',path.join(source,'XFSC/tenant/values/tenant-ocm-wstack-values.yaml'),'-f',tenant,'-n','ocm-wstack','--timeout',`${c.timeoutSeconds}s`],{namespace:'ocm-wstack',release:c.tenantRelease,cwd:source,timeout:(c.timeoutSeconds+30)*1000});
    held.check();marker=await updateMarker(r,marker,{state:'installed',updatedAt:new Date().toISOString()});
    emit({type:'phase',phase:'native-validation'});
    const report=await validate(r,c);
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
module.exports = {operation,preflight,checkout,ensureMarker,inspect,validate,lease,privateFile,MARKER};
