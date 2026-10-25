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
 const timestamp=(s,n)=>s||(Number.isFinite(n)?new Date(n*1000).toISOString():null);
 return {id,format,types:Array.isArray(v.type)?v.type:typeof v.type==='string'?[v.type]:v.vct?[v.vct]:[],issuer:{id:typeof v.issuer==='string'?v.issuer:v.issuer?.id||p.iss||null},subject:{id:v.credentialSubject?.id||p.sub||null},issuedAt:timestamp(v.issuanceDate||v.validFrom,p.iat||p.nbf),expiresAt:timestamp(v.expirationDate||v.validUntil,p.exp),status:{state:'not_checked',checkedAt:null}};
}
function overall(cryptoState,statusState,expired=false){if(cryptoState==='invalid'||statusState==='revoked'||statusState==='suspended'||expired)return 'invalid';if(cryptoState==='valid'&&['active','not_required'].includes(statusState))return 'valid';return 'indeterminate';}
function statusRef(raw,config){
 const {claims:v,tokenClaims:p}=decode(raw);const issuer=typeof v.issuer==='string'?v.issuer:v.issuer?.id||p.iss;
 const s=v.credentialStatus;if(!s||Array.isArray(s)||s.type!=='StatusList2021Entry'||s.statusPurpose!=='revocation')fail(422,'STATUS_FORMAT_UNSUPPORTED');
 let u;try{u=new URL(s.statusListCredential);}catch{fail(422,'CREDENTIAL_NOT_REVOCABLE');}
 if(u.origin!==config.publicOrigin||u.username||u.password||u.search||u.hash||!config.issuerDids.includes(issuer))fail(422,'STATUS_NOT_MANAGED_HERE');
 const match=u.pathname.match(/^\/api\/status\/(\d+)$/)||u.pathname.match(new RegExp('^/status/'+encodeURIComponent(config.tenant)+'/([0-9]+)$'));if(!match)fail(422,'STATUS_NOT_MANAGED_HERE');
 const index=Number(s.statusListIndex);if(!/^\d+$/.test(String(s.statusListIndex))||!Number.isSafeInteger(index)||index<0||index>16777215)fail(422,'CREDENTIAL_NOT_REVOCABLE');
 return {listId:match[1],index};
}
module.exports={decode,summarize,overall,statusRef};
