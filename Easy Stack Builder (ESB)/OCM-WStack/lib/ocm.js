'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {fail}=require('./config');
const POLICY='OCM W-Stack/Policy Chart';
const VERIFICATION='OCM W-Stack/Credential Verification Service Chart';
const DIDCOMM='OCM W-Stack/Didcomm';
const BRIDGE='OCM W-Stack/Pre Authorization Bridge Chart';
const WELLKNOWN='OCM W-Stack/Well Known Chart';
const NATS_CHART='INFRA/core/nats';
const RESOLVER_CHART='INFRA/core/universal-resolver';
const REGISTRY='node-654e3bca7fbeeed18f81d7c7.ps-xaas.io';
// The published dependency chart's image name is tsa/policy. The wrapper
// incorrectly replaces it with a repository at the registry root.
const POLICY_IMAGE=`${REGISTRY}/tsa/policy:1.0.0`;
const CASSANDRA_SECRET='esb-credential-verification-cassandra';
const PUBLIC_REGISTRY_SECRET='esb-ocm-public-registry';
function overrides(c) {
  return {
    [BRIDGE]: {'pre-authorization-bridge':{podAnnotations:{'inject.xfsc.io/enabled':'true','inject.xfsc.io/needs':'nats,redis,signer','inject.xfsc.io/env-prefix':'PREAUTHBRIDGE'}}},
    [WELLKNOWN]: {'well-known-service':{podAnnotations:{'inject.xfsc.io/enabled':'true','inject.xfsc.io/needs':'postgres,nats','inject.xfsc.io/env-prefix':'WELLKNOWN_SERVICE'}}},
    [POLICY]: {policy:{image:{repository:REGISTRY,name:'tsa/policy',tag:'1.0.0',sha:'',pullSecrets:''},
      podAnnotations:{'inject.xfsc.io/enabled':'true','inject.xfsc.io/needs':'nats',
        'inject.xfsc.io/env-replacements':JSON.stringify({NATS_URL:'NATS_ADDR'})},
      policy:{nats:{url:'nats://nats.infrastructure.svc.cluster.local:4222'},http:{port:8080}},service:{port:8080},
      memoryStorage:{policiesRepo:'https://github.com/eclipse-xfsc/deployment.git',policiesFolder:'OCM W-Stack/Policies'},
      addresses:{didResolver:'http://universal-resolver-service.infrastructure.svc.cluster.local:8080',
        signer:'http://signer.ocm-wstack.svc.cluster.local:8080',ocm:c.tenantUrl,NAMESPACE:null}}},
    [VERIFICATION]: {'credential-verification-service':{
      image:{pullSecrets:PUBLIC_REGISTRY_SECRET},
      podAnnotations:{'inject.xfsc.io/enabled':'true','inject.xfsc.io/needs':'nats',
        'inject.xfsc.io/env-prefix':'CREDENTIALVERIFICATION',
        'inject.xfsc.io/env-replacements':JSON.stringify({NATS_URL:'MESSAGING_NATS_URL'})},
      server:{http:{host:'0.0.0.0'}},config:{
        cassandra:{Name:CASSANDRA_SECRET,Key:'cassandra-password',cassandraHosts:'cassandra.infrastructure.svc.cluster.local',cassandraUser:'cassandra'},
        signing:{Name:'signing',Key:'signing-key'},
        didResolver:'http://universal-resolver-service.infrastructure.svc.cluster.local:8080',
        externalPresentation:{authorizeEndpoint:`http://credential-verification-service.ocm-wstack.svc.cluster.local:8080/v1/tenants/${c.tenantId}/presentation/`,
          // 1.0.2 misspells this value and renders it without quotes.
          enbaled:'"true"'},
        signerService:{presentationVerifyUrl:'http://signer.ocm-wstack.svc.cluster.local:8080/v1/presentation/verify',
          presentationSignUrl:'http://signer.ocm-wstack.svc.cluster.local:8080/v1/presentation/proof'},
        messaging:{nats:{url:'nats://nats.infrastructure.svc.cluster.local:4222'}}}}},
    [DIDCOMM]: {'didcomm-connector':{ingress:{enabled:false},podAnnotations:{'inject.xfsc.io/enabled':'false'},config:{env:'DEV',logLevel:'error',url:c.tenantUrl+'/api/didcomm',didcomm:{resolverUrl:'http://universal-resolver-service.infrastructure.svc.cluster.local:8080'},messaging:{nats:{url:'nats://nats.infrastructure.svc.cluster.local:4222'}},database:{inMemory:false,host:'cassandra.infrastructure.svc.cluster.local',port:9042,password:{passwordSecret:CASSANDRA_SECRET,passwordKey:'cassandra-password'}}}}}
  };
}
function routingValues(){
  const common=`spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers: [/spec/template/spec/hostAliases, /spec/template/metadata/annotations/esb.xfsc.io~1credentials, /spec/template/metadata/annotations/esb.xfsc.io~1nats-recovery]
    - group: apps
      kind: StatefulSet
      jsonPointers: [/spec/template/spec/hostAliases]
    - group: apps
      kind: StatefulSet
      namespace: infrastructure
      name: cassandra
      jqPathExpressions:
        - '.spec.template.spec.containers[] | select(.name == "cassandra") | .startupProbe.timeoutSeconds'
        - '.spec.template.spec.containers[] | select(.name == "cassandra") | .readinessProbe.timeoutSeconds'
        - '.spec.template.spec.containers[] | select(.name == "cassandra") | .livenessProbe.timeoutSeconds'
        - '.spec.template.spec.containers[] | select(.name == "cassandra") | .livenessProbe.failureThreshold'
    - group: apps
      kind: Deployment
      namespace: ocm-wstack
      name: credential-retrieval-service
      jsonPointers: [/spec/strategy]
  syncPolicy:
    syncOptions: [CreateNamespace=true, ServerSideApply=true, RespectIgnoreDifferences=true]
`;
  return {tag:require('../upstream-lock.json').argoRevision,esbTemplatePatch:common};
}
function applicationExcludes(c,upstream=[]) {
  return upstream.filter(p=>!(c.runtimeEnabled&&!c.runtimeServices?.didcomm&&p===DIDCOMM));
}
function values(c) {
  const common=routingValues().esbTemplatePatch;
  const conditional=Object.entries(overrides(c)).map(([p,v],i)=>`{{ ${i?'else if':'if'} eq .path.path ${JSON.stringify(p)} }}
  source:
    helm:
      valuesObject: null
      values: {{ ${JSON.stringify(JSON.stringify(JSON.stringify(v)))} }}`).join('\n')+'\n{{ end }}\n';
  return {tag:require('../upstream-lock.json').argoRevision,...(c.ocmExcludes?{excludes:c.ocmExcludes}:{}),esbTemplatePatch:common+conditional};
}

function signingKey() {
  const {privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  // The service checks this PEM label but calls x509.ParsePKCS8PrivateKey.
  // SEC1 from openssl ecparam, or standard PKCS8's PRIVATE KEY label, fails.
  return privateKey.export({format:'pem',type:'pkcs8'}).toString().replace(/(BEGIN|END) PRIVATE KEY/g,'$1 EC PRIVATE KEY');
}
function validateKey(value) {
  try {
    const pem=value.includes('BEGIN')?value:Buffer.from(value,'base64').toString('utf8');
    const match=/^\s*-----BEGIN EC PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END EC PRIVATE KEY-----\s*$/.exec(pem);
    if(!match)throw new Error();
    const key=crypto.createPrivateKey({key:Buffer.from(match[1].replace(/\s/g,''),'base64'),format:'der',type:'pkcs8'});
    if(key.asymmetricKeyType!=='ec')throw new Error();
    return key;
  } catch {fail('SIGNING_KEY','Existing signing/signing-key is incompatible with the verification service (EC PRIVATE KEY label, PKCS#8 EC contents required). It was retained; no key was replaced.');}
}
async function prerequisites(r,timeoutSeconds) {
  await require('./ocm-guard').install(r);
  await require('./ocm-startup').resolver(r);
  await verificationPullSecret(r);
  const current=await r.json('kubectl',['-n','ocm-wstack','get','secret','signing','--ignore-not-found','-o','json']);
  if(current) {
    const encoded=current.data?.['signing-key'];
    if(!encoded)fail('SIGNING_KEY','Existing signing Secret has no signing-key. It was retained.');
    const value=Buffer.from(encoded,'base64').toString('utf8');
    r.secrets.push(encoded,value);validateKey(value);
  } else {
    const key=signingKey();r.secrets.push(key,Buffer.from(key).toString('base64'));
    await r.run('kubectl',['-n','ocm-wstack','create','-f','-'],{input:JSON.stringify({apiVersion:'v1',kind:'Secret',
      metadata:{name:'signing',namespace:'ocm-wstack',labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}},type:'Opaque',stringData:{'signing-key':key}})});
  }
  // The legacy verification chart still expects the infrastructure Cassandra
  // login, unlike newer charts with their own ResourceClaims. Mirror it through
  // ESO so password refresh stays managed; never embed it in Argo Helm values.
  const existing=await r.json('kubectl',['-n','ocm-wstack','get','externalsecret',CASSANDRA_SECRET,'--ignore-not-found','-o','json']);
  if(existing&&existing.metadata?.labels?.['app.kubernetes.io/managed-by']!=='esb-ocmwstack')fail('OWNERSHIP',`Existing ExternalSecret ${CASSANDRA_SECRET} is not managed by ESB.`);
  const doc={apiVersion:'external-secrets.io/v1',kind:'ExternalSecret',metadata:{name:CASSANDRA_SECRET,namespace:'ocm-wstack',labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}},
    spec:{refreshInterval:'15m',secretStoreRef:{name:'infrastructure-openbao',kind:'ClusterSecretStore'},
      target:{name:CASSANDRA_SECRET,creationPolicy:'Owner',deletionPolicy:'Retain'},
      data:[{secretKey:'cassandra-password',remoteRef:{key:'cassandra/cassandra',property:'password'}}]}};
  await r.run('kubectl',['-n','ocm-wstack','apply','--field-manager=esb-ocmwstack','-f','-'],{input:JSON.stringify(doc)});
  await r.run('kubectl',['-n','ocm-wstack','wait','--for=condition=Ready',`externalsecret/${CASSANDRA_SECRET}`,`--timeout=${timeoutSeconds}s`],{timeout:(timeoutSeconds+15)*1000});
  r.emit({type:'ocm-prerequisites',signing:current?'retained':'created',cassandraSecret:CASSANDRA_SECRET});
}
async function verificationPullSecret(r){
  // The native 1.0.2 template unconditionally emits imagePullSecrets[].name.
  // An empty Docker config preserves anonymous registry access with a valid key.
  const secret=await r.json('kubectl',['-n','ocm-wstack','get','secret',PUBLIC_REGISTRY_SECRET,'--ignore-not-found','-o','json']);
  if(secret){
    if(secret.metadata?.labels?.['app.kubernetes.io/managed-by']!=='esb-ocmwstack'||secret.type!=='kubernetes.io/dockerconfigjson')fail('OWNERSHIP','Verification registry compatibility Secret belongs to another installation.');
    let config;try{config=JSON.parse(Buffer.from(secret.data?.['.dockerconfigjson']||'','base64').toString());}catch{}
    if(JSON.stringify(config)!==JSON.stringify({auths:{}}))fail('OWNERSHIP','Existing registry configuration is retained; the anonymous compatibility Secret must contain only empty auths.');
  }else await r.run('kubectl',['-n','ocm-wstack','create','-f','-'],{input:JSON.stringify({apiVersion:'v1',kind:'Secret',metadata:{name:PUBLIC_REGISTRY_SECRET,namespace:'ocm-wstack',labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}},type:'kubernetes.io/dockerconfigjson',stringData:{'.dockerconfigjson':JSON.stringify({auths:{}})}})});
  const d=await r.json('kubectl',['-n','ocm-wstack','get','deployment','credential-verification-service','--ignore-not-found','-o','json']);
  const list=d?.spec?.template?.spec?.imagePullSecrets;
  if(!Array.isArray(list))return;
  const invalid=list.map((x,i)=>!x||typeof x.name!=='string'||!x.name.trim()?i:null).filter(x=>x!==null).reverse();
  if(!invalid.length)return;
  const patch=[{op:'test',path:'/metadata/resourceVersion',value:d.metadata.resourceVersion},...invalid.map(i=>({op:'remove',path:`/spec/template/spec/imagePullSecrets/${i}`}))];
  await r.run('kubectl',['-n','ocm-wstack','patch','deployment','credential-verification-service','--type=json','-p',JSON.stringify(patch)]);
  r.emit({type:'verification-pull-secret',removedInvalidEntries:invalid.length,anonymous:true});
}
async function imagePreflight(r,directory) {
  let result;
  try {
    result=await require('./registry').verifyImage(r,directory,{registry:REGISTRY,repository:'tsa/policy',tag:'1.0.0'});
  } catch(e) {
    if(r.signal?.aborted||e.code==='CANCELLED')throw e;
    fail('POLICY_IMAGE',`Cannot resolve policy image ${POLICY_IMAGE} using HEAD and GET. No cluster changes were started. ${r.redact(e.message).slice(-700)}`);
  }
  r.emit({type:'image-preflight',image:POLICY_IMAGE,status:'resolvable',authentication:result.authentication});
}
function validateManifests(documents,chart) {
  if(chart===NATS_CHART){
    const server=Object.values(documents).find(d=>d?.kind==='StatefulSet'&&d.metadata?.name==='nats');
    if(!server?.spec?.template?.spec?.containers?.some(c=>c.name==='nats'&&c.ports?.some(p=>p.containerPort===8222)))fail('NATS_MONITORING','The reviewed NATS monitoring port 8222 is required for actual listener checks.');
    return;
  }
  if([BRIDGE,WELLKNOWN].includes(chart)){
    const name=chart===BRIDGE?'pre-authorization-bridge':'well-known-service';
    const d=Object.values(documents).find(x=>x?.kind==='Deployment'&&x.metadata?.name===name);
    const prefix=chart===BRIDGE?'PREAUTHBRIDGE':'WELLKNOWN_SERVICE',a=d?.spec?.template?.metadata?.annotations||{};
    if(a['inject.xfsc.io/enabled']!=='true'||a['inject.xfsc.io/env-prefix']!==prefix)fail('OCM_VALUES','Native credential/listener injection contract changed.');
    if(chart===WELLKNOWN){const importer=d.spec.template.spec.containers.find(c=>c.name===name)?.env?.find(e=>e.name==='WELLKNOWN_SERVICE_CREDENTIAL_ISSUER_IMPORTER');if(importer&&!['BROADCAST',undefined].includes(importer.value))fail('OCM_VALUES','Required Well-Known registration listener needs the native BROADCAST importer.');}
    if(chart===BRIDGE){
      const e=Object.fromEntries((d.spec.template.spec.containers.find(c=>c.name===name)?.env||[]).map(x=>[x.name,x]));
      const user=e.PREAUTHBRIDGE_REDIS_USERNAME?.valueFrom?.secretKeyRef,pw=e.PREAUTHBRIDGE_REDIS_PASSWORD?.valueFrom?.secretKeyRef;
      const claim=Object.values(documents).find(x=>x?.kind==='ResourceClaim'&&x.spec?.type==='redis'&&x.spec.externalSecretRef?.name===user?.name);
      if(!user||user.name!==pw?.name||user.key!=='username'||pw.key!=='password'||claim?.spec?.providerRef?.name!=='redis'||JSON.stringify(claim.spec.parameters?.acl)!==JSON.stringify({keys:['auth:*']}))fail('OCM_VALUES','Bridge Redis claim credentials or auth:* ACL scope changed.');
    }
    return;
  }
  if(chart===RESOLVER_CHART) {
    const service=Object.values(documents).find(d=>d?.kind==='Service'&&d.metadata?.name==='universal-resolver-service');
    const port=service?.spec?.ports?.find(p=>p.port===8080);
    const selector=service?.spec?.selector;
    const deployment=Object.values(documents).find(d=>d?.kind==='Deployment'&&selector&&Object.keys(selector).length&&Object.entries(selector).every(([k,v])=>d.spec?.template?.metadata?.labels?.[k]===v));
    const target=port?.targetPort??port?.port;
    const reaches=deployment?.spec?.template?.spec?.containers?.some(c=>c.ports?.some(p=>typeof target==='number'?p.containerPort===target:p.name===target));
    if(!port||!reaches)fail('RESOLVER_SERVICE','Rendered upstream resolver does not expose universal-resolver-service:8080 to its Deployment. Compatibility values require review before deployment.');
    return;
  }
  const name=chart===POLICY?'policy':chart===DIDCOMM?'didcomm-connector':'credential-verification-service';
  const deployments=Object.values(documents).filter(d=>d?.kind==='Deployment');
  const workload=deployments.find(d=>d.spec?.template?.spec?.containers?.some(x=>x.name===name));
  if(!workload)fail('OCM_VALUES',`No ${name} Deployment rendered; dependency contract changed.`);
  const pod=workload.spec.template,container=pod.spec.containers.find(x=>x.name===name),env=Object.fromEntries((container.env||[]).map(x=>[x.name,x]));
  if(JSON.stringify(container.env).includes('NAMESPACE'))fail('OCM_VALUES',`Unresolved namespace in ${name} environment.`);
  if(chart===DIDCOMM) {
    const required={DIDCOMMCONNECTOR_DATBASE_HOST:'cassandra.infrastructure.svc.cluster.local',DIDCOMMCONNECTOR_DATBASE_PORT:'9042',DIDCOMMCONNECTOR_DIDCOMM_RESOLVERURL:'http://universal-resolver-service.infrastructure.svc.cluster.local:8080',DIDCOMMCONNECTOR_CLOUDFORWARDING_NATS_URL:'nats://nats.infrastructure.svc.cluster.local:4222'};
    for(const [key,value] of Object.entries(required))if(String(env[key]?.value)!==value)fail('OCM_VALUES',`DIDComm ${key} override was ignored.`);
    const ref=env.DIDCOMMCONNECTOR_DATBASE_PASSWORD?.valueFrom?.secretKeyRef;
    if(ref?.name!==CASSANDRA_SECRET||ref.key!=='cassandra-password')fail('OCM_VALUES','DIDComm must use the prepared Cassandra Secret.');
    if(!/^https:\/\/[^/]+\/api\/didcomm$/.test(env.DIDCOMMCONNECTOR_URL?.value||''))fail('OCM_VALUES','DIDComm public URL is invalid.');
    if(Object.values(documents).some(d=>d?.kind==='Ingress'))fail('OCM_VALUES','DIDComm legacy Ingress must be disabled.');
  } else if(chart===POLICY) {
    if(container.image!==POLICY_IMAGE||pod.spec.imagePullSecrets?.some(x=>x.name))fail('OCM_VALUES','Policy did not render the selected tsa/policy image without a stale pull-secret reference.');
    if(env.NATS_ADDR?.value!=='nats://nats.infrastructure.svc.cluster.local:4222')fail('OCM_VALUES','Policy NATS override was ignored.');
    const port=container.ports?.find(x=>x.name==='http')?.containerPort;
    const service=Object.values(documents).find(d=>d?.kind==='Service'&&d.metadata?.name==='policy');
    if(port!==8080||!service?.spec?.ports?.some(x=>x.port===8080&&x.targetPort===8080))fail('OCM_VALUES','Policy Service does not route to its configured HTTP listener.');
  } else {
    if(pod.spec.imagePullSecrets?.some(x=>!x?.name)||!pod.spec.imagePullSecrets?.some(x=>x.name===PUBLIC_REGISTRY_SECRET))fail('OCM_VALUES','Verification must render a named anonymous registry reference; empty merge keys break Argo comparison.');
    for(const [key,secret,field] of [['CREDENTIALVERIFICATION_SIGNINGKEY','signing','signing-key'],['CREDENTIALVERIFICATION_CASSANDRAPASSWORD',CASSANDRA_SECRET,'cassandra-password']]) {
      const ref=env[key]?.valueFrom?.secretKeyRef;
      if(ref?.name!==secret||ref.key!==field)fail('OCM_VALUES',`Verification ${key} does not reference its prepared Secret.`);
    }
    if(env.CREDENTIALVERIFICATION_CASSANDRAHOSTS?.value!=='cassandra.infrastructure.svc.cluster.local'||env.CREDENTIALVERIFICATION_MESSAGING_NATS_URL?.value!=='nats://nats.infrastructure.svc.cluster.local:4222')fail('OCM_VALUES','Verification connection overrides were ignored.');
  }
}
async function inspect(r,root,directory,readYaml,chart) {
  const sources={};let i=0;
  async function walk(dir) {for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
    const file=path.join(dir,entry.name);
    if(entry.isDirectory())await walk(file);
    else if(/\.ya?ml$/.test(file))for(const doc of (await fs.readFile(file,'utf8')).split(/^---\s*$/m))if(doc.trim())sources['manifest-'+i++]=doc;
  }}
  await walk(root);validateManifests(await readYaml(r,directory,sources),chart);
}
module.exports={routingValues,overrides,values,applicationExcludes,prerequisites,verificationPullSecret,imagePreflight,inspect,validateManifests,signingKey,validateKey,POLICY,VERIFICATION,POLICY_IMAGE,CASSANDRA_SECRET,PUBLIC_REGISTRY_SECRET,DIDCOMM,RESOLVER_CHART,BRIDGE,WELLKNOWN,NATS_CHART};
