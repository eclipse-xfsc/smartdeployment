'use strict';
const {fail,object,string}=require('./errors.cjs');
const {request}=require('./http.cjs');
const {Client}=require('./http.cjs');
const {PcmIdentity,PcmAdapters}=require('./pcm.cjs');
function endpoint(value){
 string(value,1,2048);let u;try{u=new URL(value);}catch{fail(400,'CONNECTION_URL_INVALID');}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.port&&!['443'].includes(u.port)||!u.hostname.includes('.')||/\.(?:local|internal|svc|cluster\.local)$/.test(u.hostname)||require('node:net').isIP(u.hostname.replace(/^\[|\]$/g,'')))fail(400,'CONNECTION_URL_INVALID');
 return u.href.replace(/\/$/,'');
}
function hosts(values){
 if(!Array.isArray(values)||values.length>50)fail(400,'VALIDATION_ERROR');
 return [...new Set(values.map(v=>new URL(endpoint(v.includes('://')?v:'https://'+v)).hostname))];
}
class Integrations {
 constructor(runtime,db,fetcher=request){this.r=runtime;this.db=db;this.fetch=fetcher;this.value={pcm:{enabled:false},trustedHosts:[]};}
 async init(){await this.db.collection('integrations').createIndex({tenant:1},{unique:true});const saved=await this.db.collection('integrations').findOne({tenant:this.r.c.tenant});if(saved?.settings)this.apply(saved.settings);}
 apply(settings){
  this.value=settings;const r=this.r;Object.assign(r.c,{pcm:settings.pcm,offerIssuerHosts:[new URL(r.c.publicOrigin).hostname,...settings.trustedHosts],relationshipHosts:[new URL(r.c.publicOrigin).hostname,...settings.trustedHosts]});
  r.pcmIdentity=new PcmIdentity(r.c);r.pcm=settings.pcm.enabled?new PcmAdapters(r.c,new Client({pcm:settings.pcm.accountUrl,...settings.pcm.services})):null;
 }
 get(){const p=this.value.pcm;return {pcm:p.enabled?{enabled:true,issuer:p.issuer,clientId:p.clientId,tenant:p.tenant,accountUrl:p.accountUrl,cryptoNamespace:p.cryptoNamespace,services:p.services}:{enabled:false},trustedHosts:this.value.trustedHosts,redirectUri:this.r.c.publicOrigin+'/orce/pcm/callback',updatedAt:this.value.updatedAt||null};}
 async token(body){
  // Authenticated same-origin PKCE exchange: no browser CORS dependency, no
  // organizational bearer forwarding, no stored token or idempotency record.
  object(body,['grant_type','code','code_verifier','refresh_token']);
  const p=this.r.c.pcm;if(!p?.enabled)fail(409,'PCM_NOT_CONFIGURED');
  const form={client_id:p.clientId,grant_type:body.grant_type};
  if(body.grant_type==='authorization_code'){
   string(body.code,1,8192);string(body.code_verifier,43,128);
   if(!/^[A-Za-z0-9._~-]+$/.test(body.code_verifier)||body.refresh_token!==undefined)fail(400,'VALIDATION_ERROR');
   Object.assign(form,{code:body.code,code_verifier:body.code_verifier,redirect_uri:this.r.c.publicOrigin+'/orce/pcm/callback'});
  }else if(body.grant_type==='refresh_token'){
   string(body.refresh_token,1,65536);if(body.code!==undefined||body.code_verifier!==undefined)fail(400,'VALIDATION_ERROR');form.refresh_token=body.refresh_token;
  }else fail(400,'VALIDATION_ERROR');
  const value=await this.fetch(p.tokenEndpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form).toString(),timeout:10000,maxBytes:131072});
  if(typeof value?.access_token!=='string'||value.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(value.expires_in)||value.expires_in<=0||value.refresh_token!==undefined&&typeof value.refresh_token!=='string')fail(502,'PCM_OIDC_INCOMPATIBLE');
  return {access_token:value.access_token,expires_in:value.expires_in,token_type:'Bearer',...(value.refresh_token?{refresh_token:value.refresh_token}:{})};
 }
 async validate(body){
  object(body,['pcm','trustedHosts']);const trustedHosts=hosts(body.trustedHosts||[]);object(body.pcm,['enabled','issuer','clientId','tenant','accountUrl','cryptoNamespace','services']);
  if(body.pcm.enabled!==true)return {pcm:{enabled:false},trustedHosts};
  const p=body.pcm,issuer=endpoint(p.issuer),accountUrl=endpoint(p.accountUrl);string(p.clientId,1,128);string(p.tenant,1,64);
  if(!/^[a-zA-Z0-9_-]+$/.test(p.tenant))fail(400,'VALIDATION_ERROR');
  const metadata=await this.fetch(issuer+'/.well-known/openid-configuration',{timeout:5000,maxBytes:131072});
  if(metadata?.issuer!==issuer||!metadata.code_challenge_methods_supported?.includes('S256'))fail(422,'PCM_OIDC_INCOMPATIBLE');
  const remote={};for(const key of ['authorization_endpoint','token_endpoint','userinfo_endpoint']){remote[key]=endpoint(metadata[key]);if(new URL(remote[key]).origin!==new URL(issuer).origin)fail(422,'PCM_OIDC_INCOMPATIBLE');}
  object(p.services||{},['storage','retrieval','signer','status']);const services={};for(const [key,value]of Object.entries(p.services||{}))if(value)services[key]=endpoint(value);
  const cryptoNamespace=p.cryptoNamespace||'pcm-cloud';if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(cryptoNamespace))fail(400,'VALIDATION_ERROR');
  return {pcm:{enabled:true,issuer,clientId:p.clientId,tenant:p.tenant,accountUrl,cryptoNamespace,services,userInfo:remote.userinfo_endpoint,authorizationEndpoint:remote.authorization_endpoint,tokenEndpoint:remote.token_endpoint},trustedHosts};
 }
 async test(body){const settings=await this.validate(body);return {state:'succeeded',oidc:settings.pcm.enabled?'discovered':'disabled',redirectUri:this.r.c.publicOrigin+'/orce/pcm/callback'};}
 async save(body){const settings={...await this.validate(body),updatedAt:new Date().toISOString()};await this.db.collection('integrations').updateOne({tenant:this.r.c.tenant},{$set:{settings}},{upsert:true});this.apply(settings);return {state:'succeeded',...this.get()};}
}
module.exports={Integrations,endpoint,hosts};
