'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {fail}=require('./config');
const {upgrade}=require('./api-recovery');
const {atomic,composites}=require('../runtime/lib/permissions.cjs');
const NS='ocm-wstack';
function runtimeConfig(c,services={}){
 const defaults={storage:'http://storage-service.ocm-wstack.svc.cluster.local:8080',retrieval:'http://credential-retrieval-service.ocm-wstack.svc.cluster.local:8080',signer:'http://signer.ocm-wstack.svc.cluster.local:8080',status:'http://status-list-service.ocm-wstack.svc.cluster.local:8080',didcomm:'http://didcomm-connector.ocm-wstack.svc.cluster.local:9090'};

 return {storageRegion:c.storageRegion||'EU',storageCountry:c.storageCountry||'DE',publicOrigin:c.tenantUrl,uiAdminUsername:c.uiAdminUsername,uiAdminEmail:c.uiAdminEmail,tenant:c.tenantId,account:'ocm-wstack',group:'ocm-wstack',cryptoNamespace:NS,cryptoGroup:c.tenantId,holderKey:'eckey',issuerDids:['did:web:'+c.tenantHost],offerIssuerHosts:[c.tenantHost],relationshipHosts:[c.tenantHost],didcommTopic:'didcomm-connector',didcommEventType:'didcomm.message',natsUrl:'nats://nats.infrastructure.svc.cluster.local:4222',eventSubjects:[{subject:'retrieval.offering.publication',eventType:'retrieval.offering.received',type:'offers.changed'}],services:{...defaults,...services,...Object.fromEntries(Object.entries(c.runtimeServices).filter(([k])=>k!=='issuerBootstrap'))},issuerBootstrapUrl:c.runtimeServices.issuerBootstrap||'http://dummycontentsigner.ocm-wstack.svc.cluster.local:8080',managedUpstreamTenant:true,issuerCredentialEndpoint:c.tenantUrl+'/api/credential',credentialTypes:[]};
}
async function retained(r){return r.json('kubectl',['-n',NS,'get','secret','ocm-orce-runtime','--ignore-not-found','-o','json']);}
function readRetained(old,c){
 let secrets;try{secrets=JSON.parse(Buffer.from(old.data['secrets.json'],'base64'));}catch{fail('RUNTIME_SECRET','Existing runtime Secret is invalid; it was retained.');}
 if(!secrets.uiAdminHash)fail('UI_IDENTITY_MIGRATION_REQUIRED','The 12.3.17 and earlier UI identity must be migrated and verified before installing 12.3.18. See docs/MIGRATION-12.3.18.md. Existing resources were retained.');
 for(const key of ['editorHash','editorUsername','credentialSecret','offerKey','mongoPassword','mongoUri','uiAdminHash'])if(!secrets[key])fail('RUNTIME_SECRET','Existing runtime Secret lacks '+key+'; automatic replacement is refused.');
 if(secrets.editorUsername!==c.editorUsername)fail('RUNTIME_SECRET','Retain the original editor administrator username when upgrading.');
 const embedded=secrets.mongoUri.includes('@ocm-ui-mongodb.');
 if(embedded===c.useExternalMongo)fail('RUNTIME_SECRET','Retain the existing MongoDB topology; migration must be performed separately.');
 if(secrets.tenantId&&secrets.tenantId!==c.tenantId||secrets.tenantHost&&secrets.tenantHost!==c.tenantHost)fail('RUNTIME_SECRET','Existing identity bootstrap belongs to another tenant.');
 return secrets;
}
async function preflight(r,c,credentials){
 if(!c.runtimeEnabled)return;
 if(!c.runtimeImage||c.runtimeImage==='ecofacis/xfsc-orce:2.0.15')fail('RUNTIME_IMAGE_REQUIRED','Build and select the OCM 12.3.18 UI image from a verified ORCE 4.x base before deployment.');
 const old=await retained(r);
 if(old)readRetained(old,c);
 else{for(const key of ['editorPassword','uiAdminPassword'])if(typeof credentials[key]!=='string'||[...credentials[key]].length<12||Buffer.byteLength(credentials[key],'utf8')>72||/[\x00-\x1f\x7f]/.test(credentials[key]))fail('RUNTIME_CREDENTIALS','Enter separate initial editor and UI passwords of at least 12 characters on the ORCE credentials tab.');if(c.useExternalMongo)require('./mongo-uri').ports(credentials.mongoUri);}
 runtimeConfig(c);
}
async function discover(r,c){
 const list=await r.json('kubectl',['-n',NS,'get','services','-o','json']);
 const result={};
 const wanted={storage:['storage-service',8080],retrieval:['credential-retrieval-service',8080],signer:['signer',8080],status:['status-list-service',8080],didcomm:['didcomm-connector',9090]};
 for(const [key,[name,fallback]]of Object.entries(wanted)){
  const exact=list.items.find(x=>x.metadata.name===name),matching=list.items.filter(x=>x.metadata.labels?.['app.kubernetes.io/name']===name);
  const service=exact||(matching.length===1?matching[0]:null);if(!service)continue;
  const ports=(service.spec.ports||[]).filter(x=>!x.protocol||x.protocol==='TCP');
  const port=ports.find(x=>x.name==='http')||ports.find(x=>x.port===fallback)||(ports.length===1?ports[0]:null);
  if(port)result[key]=`http://${service.metadata.name}.${NS}.svc.cluster.local:${port.port}`;
 }
 r.emit({type:'runtime-upstreams',services:result,missing:Object.keys(wanted).filter(k=>!result[k]&&!c.runtimeServices[k])});
 return result;
}
async function install(r,c,credentials,directory){
 if(!c.runtimeEnabled)return {enabled:false};
 await preflight(r,c,credentials);
 await require('./storage-scope').discover(r,c);
 const gateway=c.internalGatewayRouting?await require('./gateway').publicService(r):null;
 const hostAliases=gateway?[{ip:gateway.spec.clusterIP,hostnames:[c.tenantHost]}]:[];
 const gatewayPorts=gateway?await require('./gateway').proxyPorts(r,gateway):[80,443];
 const old=await retained(r),conf=runtimeConfig(c,await discover(r,c));
 let secrets;
 if(old){secrets=readRetained(old,c); }else{
  const bcrypt=require('bcryptjs');secrets={tenantId:c.tenantId,tenantHost:c.tenantHost,editorUsername:c.editorUsername,editorHash:await bcrypt.hash(credentials.editorPassword,12),uiAdminHash:await bcrypt.hash(credentials.uiAdminPassword,12),credentialSecret:crypto.randomBytes(32).toString('hex'),offerKey:crypto.randomBytes(32).toString('hex'),mongoPassword:crypto.randomBytes(32).toString('hex')};
  secrets.mongoUri=c.useExternalMongo?credentials.mongoUri:`mongodb://ocm_ui:${secrets.mongoPassword}@ocm-ui-mongodb.${NS}.svc.cluster.local:27017/ocm_ui?authSource=admin`;
  const initial={apiVersion:'v1',kind:'Secret',metadata:{name:'ocm-orce-runtime',namespace:NS},type:'Opaque',stringData:{'secrets.json':JSON.stringify(secrets),'mongo-password':secrets.mongoPassword}};
  await r.run('kubectl',['create','-f','-'],{input:JSON.stringify(initial)});

 }
 // Never rotate keys, recreate administrators, or overwrite operator roles on upgrade.
 const values={host:c.tenantHost,hostAliases,gatewayPorts,listenerSetName:c.tenantRelease+'-xfsc-tenant-gateway',image:c.runtimeImage,secretChecksum:crypto.createHash('sha256').update(JSON.stringify(secrets)).digest('hex'),storage:{orceSize:c.orceStorageSize,mongoSize:c.mongoStorageSize,class:c.actualStorageClass},mongo:{embedded:!c.useExternalMongo,externalPorts:c.useExternalMongo?require('./mongo-uri').ports(secrets.mongoUri):[27017]},runtimeConfig:conf};
 const file=path.join(directory,'runtime-values.json');await fs.writeFile(file,JSON.stringify(values),{mode:0o600});
 r.emit({type:'phase',phase:'orce-ui'});
 await upgrade(r,['upgrade','--install','ocm-orce-ui',path.join(__dirname,'../charts-runtime'),'-n',NS,'-f',file,'--wait','--timeout',`${c.timeoutSeconds}s`],{namespace:NS,release:'ocm-orce-ui',timeout:(c.timeoutSeconds+30)*1000});
 await r.run('kubectl',['-n',NS,'rollout','status','deployment/ocm-orce',`--timeout=${c.timeoutSeconds}s`],{timeout:(c.timeoutSeconds+30)*1000});
 return {enabled:true,url:c.tenantUrl+'/orce/',editorUrl:c.tenantUrl+'/orce/editor/',authentication:'mongodb-24h-session',credentialLifecycle:'not-tested'};
}
module.exports={runtimeConfig,preflight,install,discover,readRetained};
