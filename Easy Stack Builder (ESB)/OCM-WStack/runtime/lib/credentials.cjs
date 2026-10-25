'use strict';
const {fail}=require('./errors.cjs');
function decode(raw){
 let value=raw,format='ldp_vc';
 if(typeof raw==='string'){
  if(raw.length>1048576)fail(502,'UPSTREAM_RESPONSE_TOO_LARGE');
  try{value=JSON.parse(raw);}catch{
   const jwt=raw.split('~')[0].split('.');if(jwt.length!==3)fail(422,'UNSUPPORTED_FORMAT');
   try{value=JSON.parse(Buffer.from(jwt[1],'base64url'));format=raw.includes('~')?'dc+sd-jwt':'jwt_vc_json';}catch{fail(422,'UNSUPPORTED_FORMAT');}
  }
 }
 if(!value||typeof value!=='object'||Array.isArray(value))fail(422,'UNSUPPORTED_FORMAT');
 return {claims:value.vc||value,tokenClaims:value,format};
}
function summarize(id,raw){
 const {claims:v,tokenClaims:p,format}=decode(raw);
 const timestamp=(s,n)=>{
  if(s!==undefined&&s!==null)return typeof s==='string'?s:'invalid';
  if(n===undefined||n===null)return null;
  if(!Number.isFinite(n)||Math.abs(n*1000)>8640000000000000)return 'invalid';
  return new Date(n*1000).toISOString();
 };
 return {id,format,types:Array.isArray(v.type)?v.type:typeof v.type==='string'?[v.type]:v.vct?[v.vct]:[],issuer:{id:typeof v.issuer==='string'?v.issuer:v.issuer?.id||p.iss||null},subject:{id:v.credentialSubject?.id||p.sub||null},holder:holder(v,p),issuedAt:timestamp(v.issuanceDate??v.validFrom,p.iat??p.nbf),validFrom:timestamp(v.validFrom??v.issuanceDate,p.nbf),expiresAt:timestamp(v.expirationDate??v.validUntil,p.exp),status:{state:'not_checked',checkedAt:null}};
}

// Display lifecycle combines declared validity with the native status decision.
// It never changes a cryptographic verification verdict from the Signer.
function lifecycleStatus(credential, nativeStatus, now = Date.now()) {
 const checkedAt = new Date(now).toISOString();
 const state = nativeStatus?.state || 'not_checked';
 if (['revoked', 'suspended'].includes(state)) return nativeStatus;
 const end = credential.expiresAt === null || credential.expiresAt === undefined ? null : Date.parse(credential.expiresAt);
 const start = credential.validFrom === null || credential.validFrom === undefined ? null : Date.parse(credential.validFrom);
 if ((end !== null && !Number.isFinite(end)) || (start !== null && !Number.isFinite(start)) ||
     (start !== null && end !== null && end <= start)) {
  return { state: 'not_checked', reason: 'INVALID_VALIDITY_PERIOD', checkedAt, nativeState: state };
 }
 if (end !== null && end <= now) return { state: 'expired', checkedAt, source: 'declared-validity', nativeState: state };
 if (start !== null && start > now) return { state: 'not_yet_valid', checkedAt, source: 'declared-validity', nativeState: state };
 return nativeStatus || { state: 'not_checked', checkedAt: null };
}
// Display declarations only. Native services determine validity and lifecycle.
function holder(v,p){
 const identity=v.credentialSubject?.id||p.sub||null;
 if(identity)return {id:identity,kind:'subject',label:identity};
 const cnf=p.cnf||v.cnf;
 if(cnf?.jwk&&typeof cnf.jwk==='object')return {id:null,kind:'key-binding',label:'Holder key binding ('+[cnf.jwk.kty,cnf.jwk.crv,cnf.jwk.kid].filter(x=>typeof x==='string').join(', ')+')'};
 if(typeof cnf?.kid==='string')return {id:cnf.kid,kind:'key-binding',label:cnf.kid};
 return {id:null,kind:'not-declared',label:null};
}
function statusRef(raw,config){
 const {claims:v,tokenClaims:p}=decode(raw);const issuer=typeof v.issuer==='string'?v.issuer:v.issuer?.id||p.iss;
 const token=p.status?.status_list||v.status?.status_list;
 const entry=v.credentialStatus;
 let s;
 if(token)s={type:'TokenStatusList',statusListCredential:token.uri,statusListIndex:token.idx};
 else if(entry&&!Array.isArray(entry)&&['StatusList2021Entry','BitstringStatusListEntry'].includes(entry.type)&&entry.statusPurpose==='revocation')s=entry;
 else fail(422,'STATUS_FORMAT_UNSUPPORTED');
 let u;try{u=new URL(s.statusListCredential);}catch{fail(422,'CREDENTIAL_NOT_REVOCABLE');}
 if(u.origin!==config.publicOrigin||u.username||u.password||u.search||u.hash||!config.issuerDids.includes(issuer))fail(422,'STATUS_NOT_MANAGED_HERE');
 const match=u.pathname.match(/^\/api\/status\/(\d+)$/)||u.pathname.match(new RegExp('^/status/'+encodeURIComponent(config.tenant)+'/([0-9]+)$'));if(!match)fail(422,'STATUS_NOT_MANAGED_HERE');
 const index=Number(s.statusListIndex);if(!/^\d+$/.test(String(s.statusListIndex))||!Number.isSafeInteger(index)||index<0||index>16777215)fail(422,'CREDENTIAL_NOT_REVOCABLE');
 return {listId:match[1],index,url:u.href,type:s.type==='StatusList2021Entry'?'StatusList2021':s.type==='BitstringStatusListEntry'?'BitstringStatusList':s.type};
}
module.exports={decode,summarize,statusRef,lifecycleStatus};
