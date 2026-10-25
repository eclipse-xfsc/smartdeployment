'use strict';
const crypto=require('node:crypto');
const {request}=require('./http.cjs');
const {fail}=require('./errors.cjs');
const {atomic}=require('./permissions.cjs');
class Auth {
 constructor(config,fetcher=request){this.c=config;this.fetch=fetcher;this.keys=[];this.loaded=0;this.pending=null;this.lastAttempt=0;}
 async refresh(){
  if(this.pending)return this.pending;
  if(Date.now()-this.lastAttempt<1000)fail(401,'TOKEN_INVALID');
  this.lastAttempt=Date.now();
  this.pending=this.fetch(this.c.jwks,{timeout:3000,maxBytes:65536}).then(d=>{
   if(!Array.isArray(d?.keys))fail(503,'JWKS_UNAVAILABLE');this.keys=d.keys;this.loaded=Date.now();
  }).finally(()=>{this.pending=null;});return this.pending;
 }
 async verify(token){
  if(typeof token!=='string'||token.length>16384)fail(401,'AUTHENTICATION_REQUIRED');
  let parts=token.split('.'),h,p;
  try{if(parts.length!==3)throw Error();h=JSON.parse(Buffer.from(parts[0],'base64url'));p=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{fail(401,'TOKEN_INVALID');}
  if(h.alg!=='RS256'||typeof h.kid!=='string'||h.kid.length>256||h.crit)fail(401,'TOKEN_INVALID');
  let key=this.keys.find(k=>k.kid===h.kid);
  if(!key||Date.now()-this.loaded>300000){
   try{await this.refresh();}catch{if(!key||Date.now()-this.loaded>600000)fail(503,'JWKS_UNAVAILABLE');}
   key=this.keys.find(k=>k.kid===h.kid);
  }
  try{
   if(!key||key.kty!=='RSA'||(key.use&&key.use!=='sig')||(key.alg&&key.alg!=='RS256')||!crypto.verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),crypto.createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url')))fail(401,'TOKEN_INVALID');
  }catch{fail(401,'TOKEN_INVALID');}
  const now=Math.floor(Date.now()/1000),aud=Array.isArray(p.aud)?p.aud:[p.aud];
  if(p.iss!==this.c.issuer||!aud.includes(this.c.clientId)||p.azp!==this.c.clientId||p.typ!=='Bearer'||typeof p.sub!=='string'||!p.sub||!Number.isFinite(p.exp)||p.exp<=now|| (p.nbf!==undefined&&(!Number.isFinite(p.nbf)||p.nbf>now+10)))fail(401,'TOKEN_INVALID');
  if(p.ocm_tenant!==this.c.tenant||p.ocm_account!==this.c.account||!Array.isArray(p.ocm_groups)||!p.ocm_groups.includes(this.c.group))fail(403,'SCOPE_FORBIDDEN');
  const roles=p.resource_access?.[this.c.clientId]?.roles;
  return {subject:p.sub,username:typeof p.preferred_username==='string'?p.preferred_username:p.sub,tenant:this.c.tenant,account:this.c.account,group:this.c.group,permissions:atomic.filter(v=>Array.isArray(roles)&&roles.includes(v)),expiresAt:p.exp,token};
 }
 async fromRequest(req){const h=req.headers.authorization;if(!/^Bearer [^ ]+$/.test(h||''))fail(401,'AUTHENTICATION_REQUIRED');return this.verify(h.slice(7));}
 require(ctx,p){if(p&&!ctx.permissions.includes(p))fail(403,'PERMISSION_DENIED');}
}
module.exports={Auth};
