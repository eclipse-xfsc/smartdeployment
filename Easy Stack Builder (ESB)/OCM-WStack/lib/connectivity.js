'use strict';
const {Resolver}=require('node:dns/promises');
const https=require('node:https');
const net=require('node:net');
const {setTimeout:sleep}=require('node:timers/promises');
const {fail}=require('./config');

function normalize(ip){
 if(net.isIP(ip)===6)return new URL('http://['+ip+']/').hostname.slice(1,-1);
 return ip;
}
function matches(ips,targets){return ips.length>0&&ips.every(ip=>targets.map(normalize).includes(normalize(ip)));}
async function systemLookup(host,{signal}={}){
 // Create per lookup: a long-running Node-RED process must not retain an old resolver.
 const resolver=new Resolver({timeout:2000,tries:2});
 const cancel=()=>resolver.cancel();
 signal?.addEventListener('abort',cancel,{once:true});
 try{
  if(signal?.aborted)throw Object.assign(new Error('Cancelled'),{code:'CANCELLED'});
  const answers=await Promise.allSettled([resolver.resolve4(host),resolver.resolve6(host)]);
  const errors=answers.flatMap((a,i)=>a.status==='rejected'&&!['ENODATA','ENOTFOUND'].includes(a.reason.code)?[{type:i?'AAAA':'A',code:a.reason.code||'DNS_ERROR'}]:[]);
  return {source:'system',addresses:[...new Set(answers.flatMap(a=>a.status==='fulfilled'?a.value:[]))],errors,complete:errors.length===0};
 }finally{signal?.removeEventListener('abort',cancel);}
}
function dnsJson(url,{signal}={}){
 return new Promise((resolve,reject)=>{
  const req=https.get(url,{headers:{accept:'application/dns-json'},signal},res=>{
   const chunks=[];let size=0;
   res.on('data',chunk=>{size+=chunk.length;if(size>65536)req.destroy(Object.assign(new Error('DNS response too large'),{code:'DNS_RESPONSE_SIZE'}));else chunks.push(chunk);});
   res.on('error',reject);
   res.on('end',()=>{try{if(res.statusCode!==200)throw Object.assign(new Error('DNS HTTP failure'),{code:'DNS_HTTP_'+res.statusCode});resolve(JSON.parse(Buffer.concat(chunks)));}catch(e){reject(e);}});
  });
  const timer=setTimeout(()=>req.destroy(Object.assign(new Error('DNS timeout'),{code:'ETIMEDOUT'})),5000);
  req.on('close',()=>clearTimeout(timer));req.on('error',reject);
 });
}
async function publicLookup(host,provider,{signal,query=dnsJson}={}){
 const endpoint=provider==='cloudflare'?'https://cloudflare-dns.com/dns-query':'https://dns.google/resolve';
 const results=await Promise.allSettled(['A','AAAA'].map(async type=>{
  const url=new URL(endpoint);url.searchParams.set('name',host);url.searchParams.set('type',type);
  const answer=await query(url,{signal});
  if(![0,3].includes(answer.Status))throw Object.assign(new Error('DNS lookup failed'),{code:'DNS_RCODE_'+answer.Status});
  return (answer.Answer||[]).filter(a=>a.type===(type==='A'?1:28)&&net.isIP(a.data)).map(a=>a.data);
 }));
 const errors=results.flatMap((a,i)=>a.status==='rejected'?[{type:i?'AAAA':'A',code:a.reason.code||'DNS_ERROR'}]:[]);
 return {source:provider,addresses:[...new Set(results.flatMap(a=>a.status==='fulfilled'?a.value:[]))],errors,complete:errors.length===0};
}
async function lookup(host,targets,{signal,local=systemLookup,publicResolve=publicLookup}={}){
 const first=await local(host,{signal}),views=[first];
 if(first.complete&&matches(first.addresses,targets))return {hostname:host,addresses:first.addresses,ready:true,source:first.source,views};
 if(signal?.aborted)throw Object.assign(new Error('Cancelled'),{code:'CANCELLED'});
 // Two independent public answers can establish propagation despite stale local
 // caching or blocked DNS in the deployer. A single good answer cannot hide a
 // conflicting public A/AAAA record. HTTPS application validation still follows.
 const publicViews=await Promise.all(['cloudflare','google'].map(p=>publicResolve(host,p,{signal})));
 views.push(...publicViews);
 const ready=publicViews.every(v=>v.complete&&matches(v.addresses,targets));
 return {hostname:host,addresses:ready?[...new Set(publicViews.flatMap(v=>v.addresses))]:first.addresses,ready,source:ready?'public-consensus':'unresolved',views};
}
async function addresses(host){return (await systemLookup(host)).addresses;}
async function waitDns(r,c,{resolve,check=lookup,now=Date.now,pause=sleep}={}){
 const start=now(),hosts=[c.tenantHost,...(c.publicDashboards?['argocd.'+c.domain,'grafana.'+c.domain]:[])];
 while(true){
  if(r.signal?.aborted)fail('CANCELLED','Deployment cancelled.');
  const service=await require('./gateway-routing').publicService(r),targets=(service.status?.loadBalancer?.ingress||[]).map(x=>x.ip||x.hostname).filter(Boolean);
  const targetIps=[...new Set((await Promise.all(targets.map(async t=>{
   if(net.isIP(t))return [t];
   if(resolve)return resolve(t);
   const local=await systemLookup(t,{signal:r.signal});
   if(local.complete&&local.addresses.length)return local.addresses;
   const publicViews=await Promise.all(['cloudflare','google'].map(p=>publicLookup(t,p,{signal:r.signal})));
   return publicViews.every(v=>v.complete&&v.addresses.length)?[...new Set(publicViews.flatMap(v=>v.addresses))]:[];
  }))).flat())];
  const records=await Promise.all(hosts.map(async hostname=>{
   if(resolve){const ips=await resolve(hostname);return {hostname,addresses:ips,ready:matches(ips,targetIps)};}
   return check(hostname,targetIps,{signal:r.signal});
  }));
  const ready=targetIps.length>0&&records.every(x=>x.ready);
  r.emit({type:'dns-progress',phase:'public-dns',automatic:c.externalDns,targets,targetIps,records,elapsedSeconds:Math.floor((now()-start)/1000),message:ready?'DNS points to this gateway':'Checking A and AAAA answers; per-resolver results distinguish stale records from lookup failures.'});
  if(ready)return records;
  if(now()-start>=c.timeoutSeconds*1000){
   const details=records.filter(x=>!x.ready).map(x=>x.hostname+': '+(x.views||[{source:'resolver',addresses:x.addresses,errors:[]}]).map(v=>v.source+'=['+v.addresses.join(', ')+']'+(v.errors.length?' errors='+v.errors.map(e=>e.type+':'+e.code).join(','):'')).join('; ')).join(' | ');
   const failedResolution=records.some(x=>!x.ready&&x.views?.every(v=>!v.complete));
   fail(failedResolution?'DNS_RESOLUTION_FAILED':'DNS_NOT_READY','DNS validation failed for gateway '+targets.join(', ')+'. '+details+'. The deployed tenant, TLS and UI are retained.');
  }
  await pause(Math.min(10000,c.timeoutSeconds*1000-(now()-start)),undefined,{signal:r.signal});
 }
}
module.exports={addresses,waitDns,lookup,systemLookup,publicLookup,normalize};
