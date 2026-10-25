'use strict';
const {randomUUID}=require('node:crypto');
const {Auth}=require('./auth.cjs'),{Client}=require('./http.cjs'),{Adapters}=require('./adapters.cjs'),{Coordination}=require('./coordination.cjs'),{Roles}=require('./roles.cjs'),{Events}=require('./events.cjs');
const {fail,object}=require('./errors.cjs');
const {IssuerBootstrap}=require('./issuer-bootstrap.cjs');
const {offerUrl}=require('./offers.cjs');
const {PcmAdapters,PcmIdentity}=require('./pcm.cjs');
const {Clearing}=require('./clearing.cjs');
const definitions=[
 ['POST','/pcm/token','credentials.read','pcmToken'],
 ['GET','/connections','roles.manage','connections'],['POST','/connections/test','roles.manage','testConnections'],['PUT','/connections','roles.manage','saveConnections',true],
 ['GET','/clearing/providers','credentials.receive','clearingProviders'],['POST','/clearing/requests','credentials.receive','clearingRequest',true],
 ['GET','/metrics','system.health.read','metrics'],['GET','/auth/me',null,'me'],['GET','/health/dependencies','system.health.read','health'],
 ['GET','/preferences',null,'preferences'],['PATCH','/preferences',null,'setPreferences'],['GET','/audit','audit.read','audit'],
 ['POST','/credentials/import','credentials.receive','importCredential',true],['GET','/credentials/:id/lifecycle','credentials.read','lifecycle'],['GET','/credentials/:id/provenance','credentials.read','provenance'],['GET','/credentials','credentials.read','credentials'],['GET','/credentials/:id','credentials.read','credential'],['DELETE','/credentials/:id','credentials.delete','deleteCredential',true],
 ['POST','/credentials/:id/verify','credentials.verify','verify'],['POST','/credentials/:id/revoke','credentials.revoke','revoke',true],['POST','/credential-chains/resolve','credentials.read','chain'],
 ['GET','/offers','credentials.receive','offers'],['POST','/offers/import','credentials.receive','import',true],['POST','/offers/:id/accept','credentials.receive','accept',true],['POST','/offers/:id/reject','credentials.receive','reject',true],
 ['POST','/credential-types','credentials.issue','createType',true],['PATCH','/credential-types/:id','credentials.issue','updateType',true],['DELETE','/credential-types/:id','credentials.issue','deleteType',true],['GET','/credential-types','credentials.issue','types'],['POST','/issuance','credentials.issue','issue',true],['GET','/issuance/:id','credentials.issue','job'],
 ['GET','/relationships','relationships.read','relationships'],['POST','/relationships/invitations','relationships.manage','invite',true],['POST','/relationships/accept','relationships.manage','acceptRelationship',true],['GET','/relationships/:id','relationships.read','relationship'],['PATCH','/relationships/:id','relationships.manage','updateRelationship',true],['DELETE','/relationships/:id','relationships.manage','deleteRelationship',true],['POST','/relationships/:id/block','relationships.manage','block',true],['POST','/relationships/:id/unblock','relationships.manage','unblock',true],
 ['POST','/users','roles.manage','createUser',true],['PATCH','/users/:id','roles.manage','updateUser',true],['DELETE','/users/:id','roles.manage','deleteUser',true],['GET','/roles','roles.read','roles'],['POST','/roles','roles.manage','createRole',true],['PATCH','/roles/:id','roles.manage','updateRole',true],['DELETE','/roles/:id','roles.manage','deleteRole',true],['GET','/role-assignments','roles.read','assignments'],['PUT','/role-assignments/:id','roles.manage','assign',true],['GET','/role-assignments/:id/effective','roles.read','effective']
];
const personal=definitions.filter(r=>['credentials','credential','deleteCredential','verify','revoke','importCredential','lifecycle','provenance','offers','import','accept','reject','types','issue','job'].includes(r[3])).map(r=>[r[0],'/pcm'+r[1],r[2],r[3],r[4],true]);
const routes=definitions.concat(personal,[['POST','/pcm/connection-test','credentials.read','pcmTest',false,true],['GET','/pcm/keys','credentials.receive','pcmKeys',false,true],['GET','/pcm/me','credentials.read','me',false,true]]).map(([method,path,permission,action,mutate,pcm])=>({method,path,permission,action,mutate,pcm,pattern:new RegExp('^'+path.replace(':id','([^/]+)')+'/?$')}));
class Runtime {
 constructor(config){this.c=config;this.clearing=new Clearing();this.auth=new Auth(config);this.http=new Client({...config.services,iam:config.keycloakInternal,issuerBootstrap:config.issuerBootstrapUrl||'http://dummycontentsigner:8080',...(config.pcm?.enabled?{pcm:config.pcm.accountUrl}:{})});this.adapters=new Adapters(config,this.http);this.pcmIdentity=new PcmIdentity(config);this.pcm=config.pcm?.enabled?new PcmAdapters(config,this.http):null;this.issuerBootstrap=new IssuerBootstrap(config,this.http);this.events=new Events(config,this.issuerBootstrap);this.ready=false;this.nativeState={ready:false,checks:[]};this.rates=new Map();this.counts=new Map();}
 async start(){
  if(this.ready)return; if(this.starting)return this.starting;
  this.starting=this.connect();return this.starting;
 }
 async connect(){
  const {MongoClient}=require('mongodb');while(!this.closing){try{this.mongo=new MongoClient(this.c.mongoUri,{serverSelectionTimeoutMS:3000,maxPoolSize:10});await this.mongo.connect();this.db=this.mongo.db('ocm_ui');
  this.coordination=new Coordination(this.db,this.c.offerKey);await this.coordination.init();this.roles=new Roles(this.c,this.db,this.http);this.integrations=new (require('./integrations.cjs').Integrations)(this,this.db);await this.integrations.init();this.registry=new (require('./registry.cjs').Registry)(this.db,this.events);await this.registry.init();if(this.closing){await this.mongo.close();return;}this.ready=true;this.events.start();this.issuerBootstrap.start();this.probeNative().catch(()=>{});this.probeTimer=setInterval(()=>this.probeNative().catch(()=>{}),20000);this.probeTimer.unref?.();return;
  }catch{if(this.mongo)await this.mongo.close().catch(()=>{});if(!this.closing)await new Promise(resolve=>setTimeout(resolve,5000));}}
 }
 async probeNative(){
  if(this.probing)return;this.probing=true;
  const c={tenant:this.c.tenant,account:this.c.account,group:this.c.group,token:''};
  try{const checks=await Promise.all([['storage',()=>this.adapters.records(c)],['retrieval',()=>this.adapters.offers(c)],['issuer',()=>this.issuerBootstrap.ensure()]].map(async([name,fn])=>{try{await fn();return {name,ok:true};}catch(e){return {name,ok:false,code:e.code||'UPSTREAM_UNAVAILABLE',...(e.reason?{reason:e.reason}:{}),...(e.upstreamStatus?{httpStatus:e.upstreamStatus}:{})};}}));checks.push({name:'nats',ok:this.events.connected===true});this.nativeState={ready:checks.every(x=>x.ok),checks,checkedAt:new Date().toISOString()};}finally{this.probing=false;}
 }
 limit(key){const now=Date.now();let r=this.rates.get(key);if(!r||now-r.start>=60000){r={start:now,count:0};this.rates.set(key,r);}if(++r.count>180)fail(429,'RATE_LIMITED');if(this.rates.size>10000){for(const[k,v]of this.rates)if(now-v.start>60000)this.rates.delete(k);if(this.rates.size>10000)fail(503,'SERVER_BUSY');}}
 async execute(action,c,key,body,q,requestId){
  const a=c.pcm?this.pcm:this.adapters,scope={tenant:c.tenant,subject:c.subject};
  switch(action){
   case 'pcmToken':return this.integrations.token(body);
   case 'lifecycle':return require('./lifecycle.cjs').inspect(a,c,key);
   case 'pcmTest':{const checks=await Promise.all([['credentials',()=>a.records(c)],['offers',()=>a.offers(c)],['keys',()=>a.keys(c)]].map(async([name,fn])=>{try{await fn();return {name,state:'passed'};}catch(e){return {name,state:'failed',code:e.reason||e.code||'CONNECTION_FAILED'};}}));return {state:checks.every(x=>x.state==='passed')?'succeeded':'failed',checkedAt:new Date().toISOString(),checks};}
   case 'connections':return this.integrations.get();
   case 'testConnections':return this.integrations.test(body);
   case 'saveConnections':return this.integrations.save(body);
   case 'me':return {subject:c.subject,username:c.username,tenant:c.tenant,account:c.account,group:c.group,permissions:c.permissions,expiresAt:c.expiresAt};
   case 'metrics':return {requests:Object.fromEntries(this.counts),natsConnected:this.events.connected,mongoReady:this.ready};
   case 'health':return {nats:{connected:this.events.connected,mode:(this.c.eventSubjects||[]).length?'events-and-polling':'polling'},upstreams:this.http.health(),issuerTenant:this.issuerBootstrap.state,version:'12.3.0',pcmConfigured:Boolean(this.c.pcm?.enabled),native:this.nativeState};
   case 'preferences':return await this.db.collection('ui_preferences').findOne(scope,{projection:{_id:0}})||{locale:'en',pageSize:25};
   case 'setPreferences':object(body,['locale','pageSize']);if(body.locale&&!['en','de','fr'].includes(body.locale))fail(400,'VALIDATION_ERROR');if(body.pageSize!==undefined&&![10,25,50,100].includes(body.pageSize))fail(400,'VALIDATION_ERROR');await this.db.collection('ui_preferences').updateOne(scope,{$set:{...body,updatedAt:new Date()}},{upsert:true});return body;
   case 'audit':return {items:await this.db.collection('audit_events').find({tenant:c.tenant},{projection:{_id:0}}).sort({timestamp:-1}).limit(100).toArray()};
   case 'clearingProviders':return this.clearing.list();
   case 'clearingRequest':return this.clearing.acquire(body);
   case 'credentials':return a.list(c,q);
   case 'credential':return a.detail(c,key);
   case 'provenance':{const graph=await a.provenance(c,key);graph.verifications=await this.db.collection('verification_events').find({tenant:c.tenant,account:c.account,group:c.group,wallet:c.pcm?'pcm':'ocm',credentialId:key},{projection:{_id:0,expiresAt:0}}).sort({timestamp:-1}).limit(20).toArray();return graph;}
   case 'importCredential':{const result=await a.importCredential(c,body,requestId);return {...result,lifecycle:result.credentialId&&c.permissions.includes('credentials.read')?await require('./lifecycle.cjs').inspect(a,c,result.credentialId):require('./lifecycle.cjs').awaiting('storage_readback')};}
   case 'pcmKeys':return this.pcm.keys(c);
   case 'deleteCredential':return a.remove(c,key);
   case 'verify':{const result=await a.verify(c,key);await this.db.collection('verification_events').insertOne({tenant:c.tenant,account:c.account,group:c.group,wallet:c.pcm?'pcm':'ocm',credentialId:key,verifier:c.subject,service:'XFSC Signer',overall:result.overall,cryptographic:result.cryptographic.state,status:result.status.state,timestamp:new Date(),expiresAt:new Date(Date.now()+90*86400000),requestId});return result;}
   case 'revoke':return a.revoke(c,key);
   case 'chain':return a.chain(c,body);
   case 'offers':return a.offers(c);
   case 'import':object(body,['offer','source']);return a.importOffer(c,body.offer);
   case 'accept':return {...await a.accept(c,key,true,body),lifecycle:require('./lifecycle.cjs').awaiting('asynchronous_retrieval')};
   case 'reject':return a.accept(c,key,false,body);
   case 'types':return c.pcm?this.pcm.types(c):this.registry.list(c);
   case 'createType':return this.registry.change(c,null,body);
   case 'updateType':return this.registry.change(c,key,body);
   case 'deleteType':return this.registry.change(c,key,body,true);
   case 'issue':return {...await (c.pcm?this.pcm.issue(c,body,requestId):this.registry.issue(c,body,requestId)),lifecycle:require('./lifecycle.cjs').awaiting('offer_acceptance')};
   case 'job':{const job=await this.db.collection('operation_jobs').findOne({...this.coordination.scope(c),requestId:key},{projection:{_id:0,key:0,requestHash:0}});if(!job)fail(404,'RESOURCE_NOT_FOUND');return this.coordination.publicJob(job);}
   case 'relationships':return a.relationships(c);
   case 'relationship':{const r=await a.relationship(c,key);return {did:r.remoteDid,label:r.properties?.label||'',createdAt:r.added,group:r.group};}
   case 'invite':return a.relationAction(c,null,'invitations',body);
   case 'acceptRelationship':return a.relationAction(c,null,'accept',body);
   case 'updateRelationship':return a.relationAction(c,key,'update',body);
   case 'deleteRelationship':return a.relationAction(c,key,'delete',body);
   case 'block':case 'unblock':return a.relationAction(c,key,action,body);
   case 'createUser':return this.roles.user(null,body);
   case 'updateUser':return this.roles.user(key,body);
   case 'deleteUser':return this.roles.user(key,body,true);
   case 'roles':return this.roles.list();
   case 'createRole':return this.roles.change(null,body);
   case 'updateRole':return this.roles.change(key,body);
   case 'deleteRole':return this.roles.change(key,body,true);
   case 'assignments':return this.roles.users(q.search||'');
   case 'assign':return this.roles.assign(key,body);
   case 'effective':return {permissions:await this.roles.effective(key)};
   default:fail(404,'RESOURCE_NOT_FOUND');
  }
 }
 async handle(req,res){
  const requestId=randomUUID();res.setHeader('X-Request-Id',requestId);res.setHeader('Cache-Control','no-store');
  let ctx,route;
  try{
   const url=new URL(req.originalUrl||req.url,'http://local');const path=url.pathname.replace(/^\/orce\/ui-api\/v1/,'');
   if(req.method==='GET'&&path==='/auth/config')return res.json({data:{issuer:this.c.issuer,clientId:this.c.clientId,redirectUri:this.c.publicOrigin+'/orce/auth/callback',postLogoutRedirectUri:this.c.publicOrigin+'/orce/',pcm:this.c.pcm?.enabled?{enabled:true,issuer:this.c.pcm.issuer,clientId:this.c.pcm.clientId,authorizationEndpoint:this.c.pcm.authorizationEndpoint,tokenEndpoint:this.c.pcm.tokenEndpoint,redirectUri:this.c.publicOrigin+'/orce/pcm/callback'}:{enabled:false},features:{issuance:true,relationships:true,roleManagement:true}}});
   if(req.method==='GET'&&path==='/health/live')return res.json({alive:true});
   if(req.method==='GET'&&path==='/health/ready'){
    try{if(!this.ready)throw Error();await this.db.command({ping:1});return res.json({ready:true,nativeReady:this.nativeState.ready,dependencies:this.nativeState.checks,degraded:!this.events.connected});}catch{return res.status(503).json({ready:false});}
   }
   route=routes.find(r=>r.method===req.method&&r.pattern.test(path));if(!route)fail(404,'RESOURCE_NOT_FOUND');
   if(req.headers.origin&&req.headers.origin!==this.c.publicOrigin)fail(403,'ORIGIN_FORBIDDEN');
   ctx=await this.auth.fromRequest(req);this.auth.require(ctx,route.permission);this.limit(ctx.subject);
   if(route.pcm)ctx=await this.pcmIdentity.context(ctx,req.headers['x-pcm-authorization']);
   if(!this.ready)fail(503,'COORDINATION_UNAVAILABLE');
   const body=req.body||{};object(body);
   if(['tenant','tenantId','account','accountId','group','groupId','auth'].some(k=>Object.hasOwn(body,k))||Object.hasOwn(body,'permissions')&&!['createRole','updateRole'].includes(route.action))fail(403,'SCOPE_FORBIDDEN');
   const match=path.match(route.pattern);let key;try{key=match[1]?decodeURIComponent(match[1]):undefined;}catch{fail(400,'VALIDATION_ERROR');}
   const query=Object.fromEntries(url.searchParams);
   const fn=id=>this.execute(route.action,ctx,key,body,query,id||requestId);
   let data;
   if(route.mutate){
    let reconcile;if(route.action==='deleteCredential')reconcile=()=>(ctx.pcm?this.pcm:this.adapters).absent(ctx,key);if(route.action==='revoke')reconcile=()=>(ctx.pcm?this.pcm:this.adapters).revoked(ctx,key);
    data=await this.coordination.run(ctx,(route.pcm?'pcm.':'')+route.action,req.headers['x-idempotency-key'],{key,body},fn,reconcile);
    this.events.emit('hint',{type:'resync',requiresRefresh:true});
   }else data=await fn();
   if(data?.offer){
    data.offerUrl=offerUrl(data.offer);
    if(Buffer.byteLength(data.offerUrl)<2000)data.offerQr=await require('qrcode').toDataURL(data.offerUrl,{errorCorrectionLevel:'M',margin:2,width:320});
   }
   const status=['unknown','dispatching','pending'].includes(data?.state)?202:200;
   this.counts.set(route.action,(this.counts.get(route.action)||0)+1);
   return res.status(status).json({type:route.action,auth:{subject:ctx.subject},data,requestId});
  }catch(e){
   const status=e.status||500,code=e.code||'INTERNAL_ERROR';
   if(ctx&&[401,403].includes(status)&&this.ready)await this.coordination.audit(ctx,route?.action||'request','denied',requestId,code).catch(()=>{});
   return res.status(status).json({error:{code,requestId,...(e.operationId?{operationId:e.operationId,operationState:e.operationState}:{}),...(e.upstream?{upstream:e.upstream}:{}),...(e.upstreamStatus?{upstreamStatus:e.upstreamStatus}:{}),...(e.reason?{reason:e.reason}:{})},requestId});
  }
 }
 async close(){this.closing=true;this.ready=false;clearInterval(this.probeTimer);if(singleton===this)singleton=null;this.issuerBootstrap.close();await this.events.close();if(this.mongo)await this.mongo.close();}
}
let singleton;
function instance(){if(!singleton)singleton=new Runtime(require('./config.cjs').load());return singleton;}
module.exports={Runtime,instance,routes};
