'use strict';
const crypto = require('node:crypto');

// Use addresses established by DNS validation while preserving hostname/SNI and
// normal certificate verification. This avoids reusing a stale local DNS answer.
function resolvedRequest(url,{method='GET',body,headers={},timeout=20000,signal,addresses}){
  const target=new URL(url),net=require('node:net');
  const ips=addresses.filter(ip=>net.isIP(ip)).sort((a,b)=>net.isIP(a)-net.isIP(b));
  if(!ips.length)throw new Error('No verified DNS addresses');
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?undefined:JSON.stringify(body);
    const req=(target.protocol==='https:'?require('node:https'):require('node:http')).request(target,{
      method,signal,agent:false,headers:{...headers,...(payload===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(payload)})},
      lookup:(hostname,options,done)=>options.all?done(null,ips.map(address=>({address,family:net.isIP(address)}))):done(null,ips[0],net.isIP(ips[0]))
    },res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024)req.destroy(new Error('Response exceeded 4 MiB.'));else chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{let data=null;try{data=JSON.parse(Buffer.concat(chunks));}catch{}resolve({status:res.statusCode,data,ok:res.statusCode>=200&&res.statusCode<300});});
    });
    const timer=setTimeout(()=>req.destroy(new Error('HTTP timeout')),timeout);
    req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end(payload);
  });
}
async function request(url, {method='GET',body,headers={},timeout=20000,signal,addresses} = {}) {
  if(addresses?.length)return resolvedRequest(url,{method,body,headers,timeout,signal,addresses});
  const controller=new AbortController();
  const abort=()=>controller.abort();
  if(signal?.aborted)controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeout);
  try {
    const response=await fetch(url,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},redirect:'error',signal:controller.signal});
    const chunks=[];let size=0;
    if(response.body)for await (const chunk of response.body) {size+=chunk.length;if(size>4*1024*1024)throw new Error('Response exceeded 4 MiB.');chunks.push(chunk);}
    const text=Buffer.concat(chunks).toString('utf8');let data;
    try{data=JSON.parse(text);}catch{data=null;}
    // Bodies can contain offers, pre-authorized codes and credentials: never log them.
    return {status:response.status,data,ok:response.ok};
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
async function metadataChecks(base,{requester=request,signal}={}) {
  const expectedDid=`did:web:${new URL(base).hostname}`;
  return Promise.all([
    ['issuer-metadata','/.well-known/openid-credential-issuer',d=>d?.credential_issuer===base&&d?.credential_endpoint===`${base}/api/credential`&&Object.keys(d?.credential_configurations_supported||{}).length>0],
    ['did-document','/.well-known/did.json',d=>d?.id===expectedDid&&Array.isArray(d?.verificationMethod)&&d.verificationMethod.length>0],
    ['jwks','/.well-known/jwks.json',d=>Array.isArray(d?.keys)&&d.keys.length>0]
  ].map(async([name,p,check])=>{
    try{const response=await requester(base+p,{signal});return {name,httpStatus:response.status,ok:response.ok&&check(response.data),detail:response.ok?'Expected response fields checked.':'Non-success HTTP response.'};}
    catch(e){return {name,ok:false,detail:e.name==='AbortError'?'HTTP timeout.':'HTTPS/DNS connection or JSON response failed.'};}
  }));
}
function summary(name,response,ok=response.ok) {
  const message=response.data?.message;
  return {name,httpStatus:response.status,ok,
    ...(typeof message==='string'&&['Region Id Missing.','Country Id Missing.','Tenant Id Missing.','Account Id Missing.'].includes(message)?{reason:message}:{})};
}
function credentialsIn(value,result=[]) {
  if(typeof value==='string' && (value.includes('~') || /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)))result.push(value);
  else if(Array.isArray(value))for(const child of value)credentialsIn(child,result);
  else if(value&&typeof value==='object')for(const child of Object.values(value))credentialsIn(child,result);
  return result;
}
async function exercise(c,{retrieval,storage,requester=request,emit=()=>{},signal,pollSeconds=90}={}) {
  const checks=[];
  const group=`esb-check-${crypto.randomUUID()}`;
  const paths={retrieval:`${retrieval}/v1/tenants/${encodeURIComponent(c.tenantId)}/offering`,storage:storage+require('../runtime/lib/storage-path.cjs').credentialsPath({tenant:c.tenantId,account:group,storageRegion:c.storageRegion,storageCountry:c.storageCountry})};
  const report={status:'failed',tenantId:c.tenantId,tenantUrl:c.tenantUrl,testAccount:group,checks,credentialLifecycle:'not-tested',retainedTestData:true};
  const add=(check)=>{checks.push(check);emit({type:'check',...check});};
  const call=(url,options={})=>requester(url,{...options,signal});
  try {
    // Keep separate evidence for Storage; its API failing must not hide retrieval results.
    const baseline=await call(paths.storage,{method:'POST',body:{}});
    add(summary('storage-list-before',baseline));
    const offer=await call(`${c.tenantUrl}/test/offering/create`,{method:'POST',body:{tenant_id:c.tenantId,identifier:'SDJWTCredential',payload:{given_name:'Ada',family_name:'Lovelace'}}});
    const offerUri=offer.data?.offer?.credential_offer;
    add(summary('native-offer-create',offer,offer.ok&&typeof offerUri==='string'&&offerUri.length>0));
    if(!checks.at(-1).ok)return report;
    // Use the native CredentialOffer body; no legacy BFF, issuer rewriting or token pre-consumption.
    const received=await call(`${paths.retrieval}/retrieve/${group}`,{method:'PUT',body:{credential_offer:offerUri}});
    const requestId=received.data;
    add(summary('retrieval-intake',received,received.ok&&typeof requestId==='string'&&/^[a-f0-9-]{36}$/i.test(requestId)));
    if(!checks.at(-1).ok)return report;
    report.requestId=requestId;
    const listed=await call(`${paths.retrieval}/list/${group}`);
    add(summary('retrieval-list',listed,listed.ok&&Array.isArray(listed.data)&&listed.data.some(x=>x.requestId===requestId)));
    if(!checks.at(-1).ok)return report;
    const accepted=await call(`${paths.retrieval}/clear/${group}/${requestId}`,{method:'DELETE',body:{accept:true,holderNamespace:'ocm-wstack',holderGroup:c.tenantId,holderKey:'eckey'},timeout:120000});
    const issued=credentialsIn(accepted.data);
    add(summary('retrieval-acceptance',accepted,accepted.ok&&issued.length>0));
    if(!checks.at(-1).ok)return report;
    report.credentialLifecycle='retrieved';
    let stored,found=false;
    const end=Date.now()+pollSeconds*1000;
    do {
      stored=await call(paths.storage,{method:'POST',body:{}});
      const actual=credentialsIn(stored.data);
      found=stored.ok&&issued.some(x=>actual.includes(x));
      if(found||!stored.ok||Date.now()>=end||signal?.aborted)break;
      await new Promise(resolve=>setTimeout(resolve,2000));
    } while(true);
    add(summary('storage-read-back',stored,found));
    report.status=checks.every(x=>x.ok)?'passed':'failed';
    report.credentialLifecycle=found?'retrieved-and-read-back':'retrieved-storage-unverified';
    report.credentialCount=issued.length;
    return report;
  } catch(e) {
    add({name:'transport',ok:false,detail:signal?.aborted?'Cancelled.':'A native request failed or timed out; response bodies are not exported.'});
    return report;
  }
}
module.exports = {request,metadataChecks,exercise,credentialsIn};
