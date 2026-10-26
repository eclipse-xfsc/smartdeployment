'use strict';
const crypto=require('node:crypto');
const {fail}=require('./errors.cjs');
const {httpsUrl}=require('./clearing-transport.cjs');
const algorithms={ES256:['sha256','EC','P-256'],ES384:['sha384','EC','P-384'],ES512:['sha512','EC','P-521'],RS256:['sha256','RSA'],PS256:['sha256','RSA'],EdDSA:[null,'OKP','Ed25519']};
function decode(jwt) {
  if(typeof jwt!=='string'||jwt.length>1048576||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(jwt))fail(422,'CLEARING_JWT_INVALID');
  try {const parts=jwt.split('.');const header=JSON.parse(Buffer.from(parts[0],'base64url'));const payload=JSON.parse(Buffer.from(parts[1],'base64url'));if(!header||!payload||Array.isArray(header)||Array.isArray(payload))throw Error();return {header,payload,parts};} catch {fail(422,'CLEARING_JWT_INVALID');}
}
function verify(jwt,jwk,typ) {
  const {header,payload,parts}=decode(jwt),spec=algorithms[header.alg];
  if(!spec||header.typ!==typ||header.crit||header.b64===false||jwk?.d||jwk?.kty!==spec[1]||(spec[2]&&jwk.crv!==spec[2])||(jwk.alg&&jwk.alg!==header.alg)||(jwk.use&&jwk.use!=='sig')||(jwk.key_ops&&!jwk.key_ops.includes('verify')))fail(422,'CLEARING_SIGNATURE_INVALID');
  try {
    const key=crypto.createPublicKey({key:jwk,format:'jwk'});
    if(jwk.kty==='RSA'&&key.asymmetricKeyDetails.modulusLength<2048)throw Error();
    const options={key,dsaEncoding:'ieee-p1363',...(header.alg==='PS256'?{padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:32}:{})};
    if(!crypto.verify(spec[0],Buffer.from(parts.slice(0,2).join('.')),options,Buffer.from(parts[2],'base64url')))throw Error();
  } catch {fail(422,'CLEARING_SIGNATURE_INVALID');}
  const now=Date.now()/1000;
  for(const field of ['exp','nbf','iat'])if(payload[field]!==undefined&&!Number.isFinite(payload[field]))fail(422,'CLEARING_JWT_INVALID');
  if((payload.exp!==undefined&&payload.exp<=now)||(payload.nbf!==undefined&&payload.nbf>now+30)||(payload.iat!==undefined&&payload.iat>now+30))fail(422,'CLEARING_CREDENTIAL_EXPIRED');
  return payload;
}
function didUrl(did) {
  if(typeof did!=='string'||!did.startsWith('did:web:')||did.includes('#'))fail(422,'CLEARING_ISSUER_UNSUPPORTED');
  const parts=did.slice(8).split(':').map(x=>decodeURIComponent(x));
  if(parts.some(p=>!p||p==='.'||p==='..'||/[\/?#@\\]/.test(p)))fail(422,'CLEARING_ISSUER_UNSUPPORTED');
  return httpsUrl('https://'+parts[0]+(parts.length===1?'/.well-known': '/'+parts.slice(1).map(encodeURIComponent).join('/'))+'/did.json').href;
}
async function issuerKey(payload,header,request) {
  const raw=payload.iss||payload.issuer;
  let did=typeof raw==='object'?raw?.id:raw;
  if(typeof did==='string'&&did.startsWith('https://')) {const url=httpsUrl(did);if(url.search)fail(422,'CLEARING_ISSUER_UNSUPPORTED');did='did:web:'+url.host+url.pathname.replace(/\/$/,'').replaceAll('/',':');}
  if(typeof did!=='string')fail(422,'CLEARING_ISSUER_UNSUPPORTED');
  if(did.startsWith('did:jwk:')){try{return JSON.parse(Buffer.from(did.slice(8),'base64url'));}catch{fail(422,'CLEARING_ISSUER_UNSUPPORTED');}}
  const url=didUrl(did),doc=await request(url);
  if(doc?.id!==did)fail(422,'CLEARING_ISSUER_UNSUPPORTED');
  const methods=[...(doc.verificationMethod||[]),...(doc.assertionMethod||[]).filter(x=>typeof x==='object')];
  const qualified=id=>id?.startsWith('#')?did+id:id;
  const allowed=new Set((doc.assertionMethod||[]).map(x=>qualified(typeof x==='string'?x:x.id)));
  const matches=methods.filter(m=>m.controller===did&&allowed.has(qualified(m.id))&&(!header.kid||qualified(m.id)===qualified(header.kid)||m.publicKeyJwk?.kid===header.kid||m.publicKeyJwk?.x5u===header.kid));
  if(matches.length!==1)fail(422,'CLEARING_ISSUER_KEY_UNAVAILABLE');
  const key=matches[0].publicKeyJwk;
  if(key?.kty)return key;
  fail(422,'CLEARING_ISSUER_KEY_UNAVAILABLE');
}
async function credential(jwt,request) {
  const {header,payload}=decode(jwt);
  const claims=verify(jwt,await issuerKey(payload,header,request),'vc+jwt');
  if(!Array.isArray(claims.type)||!claims.type.includes('gx:ComplianceCredential')||!claims.type.includes('VerifiableCredential')||!claims.credentialSubject)fail(422,'CLEARING_CREDENTIAL_INVALID');
  for(const [field,future] of [['validFrom',true],['validUntil',false]])if(claims[field]!==undefined){const date=Date.parse(claims[field]);if(!Number.isFinite(date)||(future?date>Date.now()+30000:date<=Date.now()))fail(422,'CLEARING_CREDENTIAL_EXPIRED');}
  return claims;
}
function proof(audience,nonce) {
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'});
  const header={typ:'openid4vci-proof+jwt',alg:'ES256',jwk:publicKey.export({format:'jwk'})};
  const payload={aud:audience,iat:Math.floor(Date.now()/1000),nonce};
  const data=[header,payload].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return data+'.'+crypto.sign('sha256',Buffer.from(data),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
module.exports={decode,verify,credential,proof,didUrl};
