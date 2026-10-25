'use strict';
const {createHash}=require('node:crypto');
const {canonical}=require('./coordination.cjs');
// The native clearance response contains credentials validated by Retrieval.
// Do not request issuance again, bypass its verifier, or expose this payload.
function representation(raw){
 if(typeof raw==='string'){try{return canonical(JSON.parse(raw));}catch{return canonical(raw);}}
 return canonical(raw);
}
function acceptedCredentials(response){
 if(!response||!Array.isArray(response.credentials)||!response.credentials.length||response.credentials.length>32)return null;
 const credentials=response.credentials.map(item=>item?.credential);
 if(credentials.some(raw=>!(typeof raw==='string'&&raw.length||raw&&typeof raw==='object'&&!Array.isArray(raw))))return null;
 if(Buffer.byteLength(JSON.stringify(credentials))>2097152)return null;
 return credentials;
}
function storageId(c,offer,index,raw){
 return 'retrieval-'+createHash('sha256').update(canonical([c.tenant,c.account,c.group,offer,index,representation(raw)])).digest('hex');
}
async function persist(adapter,c,offer,response){
 const base={upstreamRequestId:offer,accepted:true},credentials=acceptedCredentials(response);
 if(!credentials)return {...base,state:'unknown',storageConfirmation:'unconfirmed',code:'ACCEPTED_CREDENTIAL_RESPONSE_INVALID'};
 const deadline=Date.now()+12000,credentialIds=[];
 const read=()=>adapter.http.call('storage',adapter.storagePath(c),{method:'POST',headers:{...adapter.headers(c),'content-type':'application/json'},timeout:Math.max(1,Math.min(5000,deadline-Date.now()))}).then(r=>adapter.unpack(r));
 try{
  let records=await read();
  for(const [index,raw]of credentials.entries()){
   const expected=representation(raw),existing=Object.entries(records).find(([,value])=>representation(value)===expected);
   const key=existing?.[0]||storageId(c,offer,index,raw);
   if(!existing){
    if(Date.now()>=deadline)throw Object.assign(Error(),{code:'UPSTREAM_TIMEOUT'});
    // Native Storage encrypts and persists this exact payload in the requested
    // geography. This idempotent PUT never changes a native service or database.
    await adapter.http.call('storage',adapter.storagePath(c)+'/'+encodeURIComponent(key),{method:'PUT',body:raw,headers:{...adapter.headers(c),'content-type':'application/json'},timeout:Math.max(1,deadline-Date.now())});
   }
   credentialIds.push(key);
  }
  for(let attempt=0;attempt<3;attempt++){
   records=await read();
   if(credentials.every((raw,index)=>Object.hasOwn(records,credentialIds[index])&&representation(records[credentialIds[index]])===representation(raw))){
    return {...base,state:'succeeded',storageConfirmation:'confirmed',credentialIds,...(credentialIds.length===1?{credentialId:credentialIds[0]}:{})};
   }
   if(Date.now()>=deadline)break;
   if(attempt<2)await new Promise(resolve=>setTimeout(resolve,200));
  }
  return {...base,state:'unknown',storageConfirmation:'unconfirmed',credentialIds,code:'ACCEPTED_STORAGE_UNCONFIRMED'};
 }catch(e){
  // Clearance already happened. An ambiguous Storage failure must not cause
  // another issuer/token request or claim success from a list count increase.
  return {...base,state:'unknown',storageConfirmation:'unconfirmed',credentialIds,code:'ACCEPTED_STORAGE_UNCONFIRMED',storageError:e.reason||e.code||'UPSTREAM_UNAVAILABLE'};
 }
}
module.exports={persist,representation,acceptedCredentials,storageId};
