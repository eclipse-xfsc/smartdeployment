'use strict';
const {fail,object,string}=require('./errors.cjs');
const fields=['credential_offer','credential_offer_uri'];
// XFSC CreateOfferLink returns {credential_offer: <complete deep link>}.
// Normalize that envelope, protocol JSON, or a pasted link before encoding once.
// The bounded unwrap also recovers links double-wrapped by runtime 11.0.6.
function normalizeOffer(value,depth=0){
 if(depth>8)fail(400,'VALIDATION_ERROR');
 if(typeof value==='string'){
  string(value,1,16384);const raw=value.trim();
  if(raw.startsWith('{')){let parsed;try{parsed=JSON.parse(raw);}catch{fail(400,'VALIDATION_ERROR');}return normalizeOffer(parsed,depth+1);}
  let u;try{u=new URL(raw);}catch{fail(400,'VALIDATION_ERROR');}
  if(u.protocol!=='openid-credential-offer:')fail(400,'OFFER_SCHEME_UNSUPPORTED');
  if(u.host||u.username||u.password||u.hash||!['','/'].includes(u.pathname))fail(400,'VALIDATION_ERROR');
  for(const key of u.searchParams.keys())if(!fields.includes(key)||u.searchParams.getAll(key).length!==1)fail(400,'VALIDATION_ERROR');
  return normalizeOffer(Object.fromEntries(u.searchParams),depth+1);
 }
 object(value);
 if(Object.hasOwn(value,'credential_issuer')){
  if(fields.some(k=>Object.hasOwn(value,k)))fail(400,'VALIDATION_ERROR');
  const json=JSON.stringify(value);string(json,1,16000);
  return {credential_offer:json};
 }
 object(value,fields);
 if(Object.keys(value).length!==1)fail(400,'VALIDATION_ERROR');
 if(Object.hasOwn(value,'credential_offer'))return normalizeOffer(value.credential_offer,depth+1);
 const uri=string(value.credential_offer_uri,1,4096);
 if(uri.startsWith('openid-credential-offer:')){
  const normalized=normalizeOffer(uri,depth+1);
  if(!normalized.credential_offer_uri)fail(400,'VALIDATION_ERROR');
  return normalized;
 }
 let u;try{u=new URL(uri);}catch{fail(400,'VALIDATION_ERROR');}
 if(u.protocol!=='https:'||u.username||u.password||u.hash)fail(400,'OFFER_ISSUER_NOT_ALLOWED');
 return {credential_offer_uri:uri};
}
function offerUrl(value){
 const result='openid-credential-offer://?'+new URLSearchParams(normalizeOffer(value)).toString();
 return string(result,1,16384);
}
module.exports={normalizeOffer,offerUrl};
