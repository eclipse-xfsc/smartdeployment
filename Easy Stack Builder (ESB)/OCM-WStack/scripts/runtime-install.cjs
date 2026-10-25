'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),crypto=require('node:crypto');
const {validate}=require('./runtime-input.cjs');
const {atomic,composites}=require('../runtime/lib/permissions.cjs');
const [mode,ns,domain,inputFile,pod,kcadmConfig]=process.argv.slice(2);
function command(exe,args,stdin){const r=spawnSync(exe,args,{input:stdin,encoding:'utf8',maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']});if(r.status!==0)throw Error(exe+' command failed ('+(r.status??'spawn')+'). Inspect cluster events; command output suppressed to protect secrets.');return r.stdout;}
const kubectl=(args,stdin)=>command('kubectl',args,stdin);
function get(kind,name,namespace=ns){const raw=kubectl([...(namespace?['-n',namespace]:[]),'get',kind,name,'--ignore-not-found','-o','json']);return raw.trim()?JSON.parse(raw):null;}
function apply(resource){return kubectl(['apply','-f','-'],JSON.stringify(resource));}
const cfg=validate(JSON.parse(fs.readFileSync(inputFile,'utf8')));
const origin='https://cloud-wallet.'+domain;
function ingressPreflight(){
 const controllers=JSON.parse(kubectl(['get','deployments','-A','-l','app.kubernetes.io/component=controller,app.kubernetes.io/name=ingress-nginx','-o','json']));
 const controller=controllers.items.find(d=>d.spec.template.spec.containers.some(c=>{
  const args=c.args||[],value=(key,def)=>args.find(x=>x.startsWith(key+'='))?.split('=').slice(1).join('=')||def;
  return value('--controller-class','k8s.io/ingress-nginx')==='k8s.io/ingress-nginx'&&value('--watch-namespace',ns)===ns&&!value('--watch-namespace-selector','');
 }));
 if(!controller)throw Error('No existing ingress-nginx controller can serve nginx-orce-cluster in the target namespace.');
 const cls=get('ingressclass','nginx-orce-cluster','');
 if(cls&&cls.spec.controller!=='k8s.io/ingress-nginx')throw Error('nginx-orce-cluster belongs to another controller.');
 return controller;
}
function kc(method,resource,body,realm=ns){
 const args=['-n',ns,'exec','-i',pod,'--','/opt/bitnami/keycloak/bin/kcadm.sh',method,resource,'--config',kcadmConfig,'-r',realm];if(body!==undefined)args.push('-f','-');
 const raw=kubectl(args,body===undefined?undefined:JSON.stringify(body));try{return JSON.parse(raw);}catch{return raw;}
}
function findClient(name){return kc('get','clients?clientId='+encodeURIComponent(name))[0];}
function ensureClient(name,body){let existing=findClient(name);if(!existing){kc('create','clients',{clientId:name,...body});existing=findClient(name);}else kc('update','clients/'+existing.id,body);return existing;}
async function main(){
 const controller=ingressPreflight();if(mode==='preflight')return;
 const cls=get('ingressclass','nginx-orce-cluster','');if(!cls)apply({apiVersion:'networking.k8s.io/v1',kind:'IngressClass',metadata:{name:'nginx-orce-cluster'},spec:{controller:'k8s.io/ingress-nginx'}});
 const configMappers=[['ocm_tenant','tenant_space','String'],['ocm_account','ocm-wstack','String'],['ocm_groups','["ocm-wstack"]','JSON']].map(([name,value,typ])=>({name,protocol:'openid-connect',protocolMapper:'oidc-hardcoded-claim-mapper',config:{'claim.name':name,'claim.value':value,'jsonType.label':typ,'access.token.claim':'true','id.token.claim':'false'}}));
 configMappers.push({name:'ocm-ui-audience',protocol:'openid-connect',protocolMapper:'oidc-audience-mapper',config:{'included.client.audience':'ocm-ui','access.token.claim':'true','id.token.claim':'false'}});
 const ui=ensureClient('ocm-ui',{name:'OCM UI',enabled:true,protocol:'openid-connect',publicClient:true,standardFlowEnabled:true,implicitFlowEnabled:false,directAccessGrantsEnabled:false,serviceAccountsEnabled:false,fullScopeAllowed:true,redirectUris:[origin+'/orce/auth/callback'],webOrigins:[origin],attributes:{'pkce.code.challenge.method':'S256','post.logout.redirect.uris':origin+'/orce/'}});
 const mapperPath='clients/'+ui.id+'/protocol-mappers/models',oldMappers=kc('get',mapperPath);
 for(const mapper of configMappers){const old=oldMappers.find(x=>x.name===mapper.name);if(old)kc('update',mapperPath+'/'+old.id,{...mapper,id:old.id});else kc('create',mapperPath,mapper);}
 const rolePath='clients/'+ui.id+'/roles';let roles=kc('get',rolePath);
 for(const permission of atomic)if(!roles.some(r=>r.name===permission))kc('create',rolePath,{name:permission,description:'OCM UI permission',attributes:{'ocm-ui-system':['true']}});
 roles=kc('get',rolePath);
 for(const [name,permissions]of Object.entries(composites)){
  // Seed only once. Operator-customized composites survive every rerun.
  if(!roles.some(r=>r.name===name)){kc('create',rolePath,{name,composite:true,attributes:{'ocm-ui-managed':['true']}});kc('create',rolePath+'/'+name+'/composites',roles.filter(r=>permissions.includes(r.name)));}
 }
 const backend=ensureClient('ocm-ui-backend',{enabled:true,protocol:'openid-connect',publicClient:false,standardFlowEnabled:false,directAccessGrantsEnabled:false,serviceAccountsEnabled:true,fullScopeAllowed:false,clientAuthenticatorType:'client-secret'});
 const secret=kc('get','clients/'+backend.id+'/client-secret').value;
 const sa=kc('get','clients/'+backend.id+'/service-account-user');
 const realmClient=findClient('realm-management'),realmRoles=kc('get','clients/'+realmClient.id+'/roles');
 const needed=['query-users','view-users','manage-users','view-clients','manage-clients'];
 kc('create','users/'+sa.id+'/role-mappings/clients/'+realmClient.id,realmRoles.filter(r=>needed.includes(r.name)));
 // With fullScopeAllowed=false, assignments also require explicit token scope mappings.
 kc('create','clients/'+backend.id+'/scope-mappings/clients/'+realmClient.id,realmRoles.filter(r=>needed.includes(r.name)));
 let user=kc('get','users?username='+encodeURIComponent(cfg.uiAdminUsername)+'&exact=true')[0];
 if(!user){
  kc('create','users',{username:cfg.uiAdminUsername,email:cfg.uiAdminEmail,firstName:cfg.uiAdminFirstName||'',lastName:cfg.uiAdminLastName||'',enabled:true,emailVerified:false,requiredActions:['UPDATE_PASSWORD'],credentials:[{type:'password',value:cfg.uiAdminPassword,temporary:true}]});
  user=kc('get','users?username='+encodeURIComponent(cfg.uiAdminUsername)+'&exact=true')[0];
  const admin=kc('get',rolePath+'/administrator');kc('create','users/'+user.id+'/role-mappings/clients/'+ui.id,[admin]);
 }
 const effective=kc('get','users/'+user.id+'/role-mappings/clients/'+ui.id+'/composite');
 if(!effective.some(r=>r.name==='roles.manage'))throw Error('The configured existing UI administrator has no roles.manage permission; use the established administrator username.');
 const old=get('secret','ocm-orce-runtime');let secrets;
 if(old){secrets=JSON.parse(Buffer.from(old.data['secrets.json'],'base64'));}
 else{
  const bcrypt=require('bcryptjs');
  secrets={editorUsername:cfg.editorUsername,editorHash:await bcrypt.hash(cfg.editorPassword,12),adminClientSecret:secret,credentialSecret:crypto.randomBytes(32).toString('hex'),offerKey:crypto.randomBytes(32).toString('hex'),mongoPassword:crypto.randomBytes(32).toString('hex')};
 }
 secrets.adminClientSecret=secret;
 secrets.mongoUri=cfg.useExternalMongo?cfg.mongoUri:'mongodb://ocm_ui:'+secrets.mongoPassword+'@ocm-ui-mongodb:27017/ocm_ui?authSource=admin';
 apply({apiVersion:'v1',kind:'Secret',metadata:{name:'ocm-orce-runtime',namespace:ns},type:'Opaque',stringData:{'secrets.json':JSON.stringify(secrets),'mongo-password':secrets.mongoPassword}});
 const conf={publicOrigin:origin,issuer:'https://auth-cloud-wallet.'+domain+'/realms/'+ns,jwks:'http://keycloak:80/realms/'+ns+'/protocol/openid-connect/certs',keycloakInternal:'http://keycloak:80',realm:ns,clientId:'ocm-ui',adminClientId:'ocm-ui-backend',tenant:'tenant_space',account:'ocm-wstack',group:'ocm-wstack',cryptoNamespace:ns,cryptoGroup:'',holderKey:'eckey',issuerDids:['did:web:cloud-wallet.'+domain],offerIssuerHosts:[...new Set(['cloud-wallet.'+domain,...cfg.offerIssuerHosts])],relationshipHosts:[...new Set(['cloud-wallet.'+domain,...cfg.relationshipHosts])],didcommTopic:'didcomm-connector',didcommEventType:'didcomm.message',natsUrl:'nats://nats:4222',eventSubjects:[],services:{storage:'http://storage-service:8080',retrieval:'http://credential-retrieval-service:8080',signer:'http://signer:8080',status:'http://status-list-service-chart-service:8080',didcomm:'http://didcomm-connector:9090'},credentialTypes:[{id:'DeveloperCredential',identifier:'DeveloperCredential',subject:'issuer.dummycontentsigner.request',fields:{given_name:{required:true,maxLength:100},family_name:{required:true,maxLength:100}}},{id:'SDJWTCredential',identifier:'SDJWTCredential',subject:'issuer.dummycontentsigner.request',fields:{given_name:{required:true,maxLength:100},family_name:{required:true,maxLength:100}}}]};
 const values={host:'cloud-wallet.'+domain,tlsSecret:'xfsc-wildcard',ingressClass:'nginx-orce-cluster',controllerNamespace:controller.metadata.namespace,storage:{orceSize:cfg.orceStorageSize,mongoSize:cfg.mongoStorageSize,class:cfg.storageClass},mongo:{embedded:!cfg.useExternalMongo,externalPorts:cfg.useExternalMongo?[...new Set(cfg.mongoUri.split('://')[1].split('/')[0].split('@').pop().split(',').map(h=>Number(h.match(/:(\d+)$/)?.[1]||27017)))]:[]},runtimeConfig:conf,secretChecksum:crypto.createHash('sha256').update(JSON.stringify(secrets)).digest('hex')};
 const tmp=path.join(path.dirname(inputFile),'runtime-values-'+process.pid+'.json');
 fs.writeFileSync(tmp,JSON.stringify(values),{mode:0o600});
 try{command('helm',['upgrade','--install','ocm-orce-ui',path.join(__dirname,'../ORCE Runtime'),'--namespace',ns,'-f',tmp,'--wait','--timeout','15m']);}finally{fs.rmSync(tmp,{force:true});}
 kubectl(['-n',ns,'rollout','status','deployment/ocm-orce','--timeout=15m']);
}
main().catch(e=>{console.error('ORCE provisioning: '+e.message);process.exit(1);});
