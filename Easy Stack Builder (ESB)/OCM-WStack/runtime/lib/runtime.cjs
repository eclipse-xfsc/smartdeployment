'use strict';
const {randomUUID}=require('node:crypto');
const {LocalAuth}=require('./local-auth.cjs'),{Client}=require('./http.cjs'),{Adapters}=require('./adapters.cjs'),{Coordination}=require('./coordination.cjs'),{LocalRoles}=require('./local-roles.cjs'),{Events}=require('./events.cjs');
const {fail,object}=require('./errors.cjs');
const {IssuerBootstrap}=require('./issuer-bootstrap.cjs');
const {offerUrl}=require('./offers.cjs');
const {Clearing}=require('./clearing.cjs');
const definitions=[
 ['GET','/clearing/inputs','clearing.request','clearingInputs'],['GET','/clearing/requests','clearing.request','clearingHistory'],['GET','/clearing/requests/:id','clearing.request','clearingJob'],['POST','/clearing/requests/:id/store','clearing.request','clearingStore',true],
 ['GET','/clearing/providers','clearing.request','clearingProviders'],['POST','/clearing/requests','clearing.request','clearingRequest',true],
 ['GET','/metrics','system.health.read','metrics'],['GET','/auth/me',null,'me'],['GET','/health/dependencies','system.health.read','health'],
 ['GET','/preferences',null,'preferences'],['PATCH','/preferences',null,'setPreferences'],['GET','/audit','audit.read','audit'],
 ['POST','/credentials/import','credentials.receive','importCredential',true],['GET','/credentials/:id/lifecycle','credentials.read','lifecycle'],['GET','/credentials/:id/provenance','credentials.read','provenance'],['GET','/credentials','credentials.read','credentials'],['GET','/credentials/:id','credentials.read','credential'],['DELETE','/credentials/:id','credentials.delete','deleteCredential',true],
 ['POST','/credentials/:id/refresh','credentials.issue','refresh'],['POST','/credentials/:id/verify','credentials.verify','verify'],['POST','/credentials/:id/revoke','credentials.revoke','revoke',true],['POST','/credential-chains/resolve','credentials.read','chain'],
 ['GET','/offers','credentials.receive','offers'],['POST','/offers/import','credentials.receive','import',true],['POST','/offers/:id/accept','credentials.receive','accept',true],['POST','/offers/:id/reject','credentials.receive','reject',true],
 ['POST','/credential-types','credentials.issue','createType',true],['PATCH','/credential-types/:id','credentials.issue','updateType',true],['DELETE','/credential-types/:id','credentials.issue','deleteType',true],['GET','/credential-types','credentials.issue','types'],['POST','/issuance','credentials.issue','issue',true],['GET','/issuance/:id','credentials.issue','job'],
 ['GET','/relationships','relationships.read','relationships'],['POST','/relationships/invitations','relationships.write','invite',true],['POST','/relationships/accept','relationships.write','acceptRelationship',true],['GET','/relationships/:id','relationships.read','relationship'],['PATCH','/relationships/:id','relationships.write','updateRelationship',true],['DELETE','/relationships/:id','relationships.write','deleteRelationship',true],['POST','/relationships/:id/block','relationships.write','block',true],['POST','/relationships/:id/unblock','relationships.write','unblock',true],
 ['POST','/users','admin.users','createUser',true],['PATCH','/users/:id','admin.users','updateUser',true],['DELETE','/users/:id','admin.users','deleteUser',true],['GET','/roles','roles.read','roles'],['POST','/roles','admin.users','createRole',true],['PATCH','/roles/:id','admin.users','updateRole',true],['DELETE','/roles/:id','admin.users','deleteRole',true],['GET','/role-assignments','roles.read','assignments'],['PUT','/role-assignments/:id','admin.users','assign',true],['GET','/role-assignments/:id/effective','roles.read','effective']
];
const routes=definitions.map(([method,path,permission,action,mutate])=>({method,path,permission,action,mutate,pattern:new RegExp('^'+path.replace(':id','([^/]+)')+'/?$')}));
const modules=["Auth", "Credentials", "ClearingCenter", "Issue", "Relationships", "Provenance", "Base"].map(name=>require('./modules/'+name+'.cjs'));
for(const route of routes)route.module=["Auth", "Credentials", "ClearingCenter", "Issue", "Relationships", "Provenance", "Base"][modules.findIndex(item=>item.actions.includes(route.action))];
class Runtime {
 constructor(config){this.c=config;this.clearing=new Clearing(config);this.http=new Client({...config.services,issuerBootstrap:config.issuerBootstrapUrl||'http://dummycontentsigner:8080'});this.adapters=new Adapters(config,this.http);this.issuerBootstrap=new IssuerBootstrap(config,this.http);this.events=new Events(config,this.issuerBootstrap);this.adapters.statusTransport=this.events;this.ready=false;this.nativeState={ready:false,checks:[]};this.rates=new Map();this.counts=new Map();}
 async start(){
  if(this.ready)return; if(this.starting)return this.starting;
  this.starting=this.connect();return this.starting;
 }
 async connect(){
  const {MongoClient}=require('mongodb');while(!this.closing){try{this.mongo=new MongoClient(this.c.mongoUri,{serverSelectionTimeoutMS:3000,maxPoolSize:10});await this.mongo.connect();this.db=this.mongo.db('ocm_ui');
  this.coordination=new Coordination(this.db,this.c.offerKey);await this.coordination.init();await this.clearing.init(this.db,this.adapters,this.coordination);this.roles=new LocalRoles(this.c,this.db);await this.roles.init();this.auth=new LocalAuth(this.c,this.db,this.roles);await this.auth.init();this.registry=new (require('./registry.cjs').Registry)(this.db,this.events);await this.registry.init();if(this.closing){await this.mongo.close();return;}this.ready=true;this.events.start();this.issuerBootstrap.start();this.probeNative().catch(()=>{});this.probeTimer=setInterval(()=>this.probeNative().catch(()=>{}),20000);this.probeTimer.unref?.();return;
  }catch{if(this.mongo)await this.mongo.close().catch(()=>{});if(!this.closing)await new Promise(resolve=>setTimeout(resolve,5000));}}
 }
 async probeNative(){
  if(this.probing)return;this.probing=true;
  const c={tenant:this.c.tenant,account:this.c.account,group:this.c.group,token:this.c.nativeToken||''};
  try{const checks=await Promise.all([['storage',()=>this.adapters.records(c)],['retrieval',()=>this.adapters.offers(c)],['issuer',()=>this.issuerBootstrap.ensure()],['didcomm',()=>this.adapters.relationships(c)]].map(async([name,fn])=>{try{await fn();return {name,ok:true};}catch(e){return {name,ok:false,code:e.code||'UPSTREAM_UNAVAILABLE',...(e.reason?{reason:e.reason}:{}),...(e.upstreamStatus?{httpStatus:e.upstreamStatus}:{})};}}));checks.push({name:'nats',ok:this.events.connected===true});this.nativeState={ready:checks.every(x=>x.ok),checks,checkedAt:new Date().toISOString()};}finally{this.probing=false;}
 }
 limit(key){const now=Date.now();let r=this.rates.get(key);if(!r||now-r.start>=60000){r={start:now,count:0};this.rates.set(key,r);}if(++r.count>180)fail(429,'RATE_LIMITED');if(this.rates.size>10000){for(const[k,v]of this.rates)if(now-v.start>60000)this.rates.delete(k);if(this.rates.size>10000)fail(503,'SERVER_BUSY');}}
 async execute(action,c,key,body,q,requestId){
  const a=this.adapters,scope={tenant:c.tenant,subject:c.subject};
  const module=modules.find(item=>item.actions.includes(action));
  if(!module)fail(404,'RESOURCE_NOT_FOUND');
  return module.execute.call(this,action,c,key,body,q,requestId);
 }
 async handle(req,res,moduleName){
  const requestId=randomUUID();res.setHeader('X-Request-Id',requestId);res.setHeader('Cache-Control','no-store');
  let ctx,route;
  try{
   const url=new URL(req.originalUrl||req.url,'http://local');const path=url.pathname.replace(/^\/orce\/ui-api\/v1/,'');
   if(req.method==='GET'&&path==='/auth/config')return res.json({data:{mode:'local-session',sessionHours:24,features:{pcm:false,issuance:true,relationships:true,roleManagement:true}}});
   if(req.method==='POST'&&path==='/auth/login'){
    if(!this.ready)fail(503,'COORDINATION_UNAVAILABLE');
    return res.json({data:await this.auth.login(req,res,req.body||{}),requestId});
   }
   if(req.method==='POST'&&path==='/auth/csrf'){
    if(!this.ready)fail(503,'COORDINATION_UNAVAILABLE');
    this.auth.sameOrigin(req);const current=await this.auth.fromRequest(req);
    const token=this.auth.csrfToken(current.sessionHash);
    return res.json({data:{csrfToken:token},requestId});
   }
   if(req.method==='POST'&&['/auth/logout','/auth/password'].includes(path)){
    if(!this.ready)fail(503,'COORDINATION_UNAVAILABLE');
    const current=await this.auth.fromRequest(req);this.auth.csrf(req,current);
    const data=path==='/auth/logout'?await this.auth.logout(req,res,current):await this.auth.changePassword(current,req.body||{});
    return res.json({data,requestId});
   }
   if(req.method==='GET'&&path==='/health/live')return res.json({alive:true});
   if(req.method==='GET'&&path==='/health/ready'){
    try{if(!this.ready)throw Error();await this.db.command({ping:1});return res.json({ready:true,nativeReady:this.nativeState.ready,dependencies:this.nativeState.checks,degraded:!this.events.connected});}catch{return res.status(503).json({ready:false});}
   }
   route=routes.find(r=>r.method===req.method&&r.pattern.test(path)&&(!moduleName||r.module===moduleName));if(!route)fail(404,'RESOURCE_NOT_FOUND');
   if(req.headers.origin&&req.headers.origin!==this.c.publicOrigin)fail(403,'ORIGIN_FORBIDDEN');
   if(!this.ready)fail(503,'COORDINATION_UNAVAILABLE');
   ctx=await this.auth.fromRequest(req);this.auth.require(ctx,route.permission);this.limit(ctx.subject);
   if(req.method!=='GET')this.auth.csrf(req,ctx);
   if(ctx.passwordChangeRequired&&route.action!=='me')fail(403,'PASSWORD_CHANGE_REQUIRED');
   const body=req.body||{};object(body);
   if(['tenant','tenantId','account','accountId','group','groupId','auth'].some(k=>Object.hasOwn(body,k))||Object.hasOwn(body,'permissions')&&!['createRole','updateRole'].includes(route.action))fail(403,'SCOPE_FORBIDDEN');
   const match=path.match(route.pattern);let key;try{key=match[1]?decodeURIComponent(match[1]):undefined;}catch{fail(400,'VALIDATION_ERROR');}
   const query=Object.fromEntries(url.searchParams);
   const fn=id=>this.execute(route.action,ctx,key,body,query,id||requestId);
   let data;
   if(route.mutate){
    let reconcile;if(route.action==='clearingStore')reconcile=()=>this.clearing.store(ctx,key);if(route.action==='deleteCredential')reconcile=()=>this.adapters.absent(ctx,key);if(route.action==='revoke')reconcile=()=>this.adapters.revoked(ctx,key);
    data=await this.coordination.run(ctx,route.action,req.headers['x-idempotency-key'],{key,body},fn,reconcile);
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
 async close(){this.closing=true;this.ready=false;clearInterval(this.probeTimer);if(singleton===this)singleton=null;this.issuerBootstrap.close();await this.clearing.close();await this.events.close();if(this.mongo)await this.mongo.close();}
}
let singleton;
function instance(){if(!singleton)singleton=new Runtime(require('./config.cjs').load());return singleton;}
module.exports={Runtime,instance,routes};
