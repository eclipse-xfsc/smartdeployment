#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),https=require('node:https'),http=require('node:http'),net=require('node:net');
const core=require('../lib/ocm-guard-core');
const root='/var/run/secrets/kubernetes.io/serviceaccount';
const paths={deployments:'apis/apps/v1',replicasets:'apis/apps/v1',resourceclaims:'apis/resources.xfsc.io/v1alpha1',resourceproviders:'apis/resources.xfsc.io/v1alpha1',externalsecrets:'apis/external-secrets.io/v1',secrets:'api/v1',pods:'api/v1',endpoints:'api/v1'};
function apiPath(kind,name,namespace){return '/'+paths[kind]+(namespace?'/namespaces/'+encodeURIComponent(namespace):'')+'/'+kind+(name?'/'+encodeURIComponent(name):'');}
const CONNECTION_CODES=new Set(['ECONNRESET','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','EPIPE','EPROTO','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
function jsonRequest(url,{headers={},method='GET',body,ca,target='guard-http',operation='request',timeoutMs=10000}={}){return new Promise((resolve,reject)=>{
 const parsed=new URL(url),transport=parsed.protocol==='https:'?https:http;
 const connection={target,operation,host:parsed.hostname.replace(/^\[|\]$/g,''),port:Number(parsed.port||(parsed.protocol==='https:'?443:80))};
 let req,timer,finished=false;
 function finish(error,data){if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(data);}
 const error=(code,cause,status)=>Object.assign(new Error(code),{code,...(status?{status}:{}),connection:{...connection,cause}});
 req=transport.request(parsed,{headers,method,ca},response=>{
  let bytes=0,data='';response.setEncoding('utf8');
  response.once('aborted',()=>finish(error('GUARD_TRANSPORT','ECONNRESET')));
  response.once('error',e=>{finish(error('GUARD_TRANSPORT',CONNECTION_CODES.has(e.code)?e.code:'REQUEST_FAILED'));req.destroy();});
  response.on('data',b=>{bytes+=Buffer.byteLength(b);if(bytes>16*1024*1024){finish(error('GUARD_TRANSPORT','RESPONSE_LIMIT'));req.destroy();}else data+=b;});
  response.once('end',()=>{if(response.statusCode<200||response.statusCode>=300)return finish(error('GUARD_HTTP','HTTP_STATUS',response.statusCode));try{finish(null,JSON.parse(data));}catch{finish(error('GUARD_JSON','INVALID_JSON'));}});
 });
 // Bound the complete request, including connection/TLS and response body.
 timer=setTimeout(()=>{finish(error('GUARD_TRANSPORT','ETIMEDOUT'));req.destroy();},timeoutMs);
 req.once('error',e=>finish(error('GUARD_TRANSPORT',CONNECTION_CODES.has(e.code)?e.code:'REQUEST_FAILED')));
 req.end(body);
});}
function failureStatus(e,now=Date.now){return {ready:false,code:e.code||'GUARD_RECONCILE',...(e.status?{httpStatus:e.status}:{}),...(e.connection?{connection:e.connection}:{}),checkedAt:new Date(now()).toISOString()};}
function natsPing(url,credentials={}, {dial=net.connect}={}){return new Promise((resolve,reject)=>{
 const u=new URL(url);if(u.protocol!=='nats:'||u.hostname!=='nats.infrastructure.svc.cluster.local'||u.port!=='4222')return reject(Object.assign(new Error('NATS_ENDPOINT_CONTRACT'),{code:'NATS_ENDPOINT_CONTRACT'}));
 const socket=dial({host:u.hostname,port:4222});let text='',connected=false,done=false;
 const finish=ok=>{if(done)return;done=true;socket.destroy();ok?resolve():reject(Object.assign(new Error('NATS_UNAVAILABLE'),{code:'NATS_UNAVAILABLE'}));};
 socket.setTimeout(10000,()=>finish(false));socket.on('error',()=>finish(false));socket.on('end',()=>finish(false));
 socket.on('data',b=>{text+=b.toString();if(text.length>65536)return finish(false);let i;while((i=text.indexOf('\r\n'))>=0){const line=text.slice(0,i);text=text.slice(i+2);if(line.startsWith('-ERR'))return finish(false);if(line.startsWith('INFO ')&&!connected){let info;try{info=JSON.parse(line.slice(5));}catch{return finish(false);}if(info.tls_required)return finish(false);connected=true;socket.write('CONNECT '+JSON.stringify({verbose:false,pedantic:false,...(u.username&&u.password?{user:decodeURIComponent(u.username),pass:decodeURIComponent(u.password)}:u.username?{auth_token:decodeURIComponent(u.username)}:{}),...credentials})+'\r\nPING\r\n');}else if(line==='PING')socket.write('PONG\r\n');else if(line==='PONG'&&connected)finish(true);}});
});}
function clusterApi(){
 const host=process.env.KUBERNETES_SERVICE_HOST;
 const server='https://'+(net.isIP(host)===6?'['+host+']':host)+':'+(process.env.KUBERNETES_SERVICE_PORT_HTTPS||'443');
 const request=(path,options={})=>jsonRequest(server+path,{...options,target:'kubernetes-api',ca:fs.readFileSync(root+'/ca.crt'),headers:{Authorization:'Bearer '+fs.readFileSync(root+'/token','utf8').trim(),...options.headers}});
 return {
  get:(kind,name,ns)=>request(apiPath(kind,name,ns),{operation:'get/'+kind}),
  async list(kind,ns){let items=[],cursor='';do{const d=await request(apiPath(kind,null,ns)+'?limit=500'+(cursor?'&continue='+encodeURIComponent(cursor):''),{operation:'list/'+kind});if(!Array.isArray(d.items))core.blocked('KUBE_LIST_CONTRACT');items.push(...d.items);cursor=d.metadata?.continue||'';}while(cursor);return items;},
  annotate(d,annotations){const current=d.spec.template.metadata.annotations||{};return request(apiPath('deployments',d.metadata.name,core.NS),{operation:'patch/deployments',method:'PATCH',headers:{'Content-Type':'application/json-patch+json'},body:JSON.stringify([{op:'test',path:'/metadata/resourceVersion',value:d.metadata.resourceVersion},{op:'add',path:'/spec/template/metadata/annotations',value:{...current,...annotations}}])});},
  async connections(){
   const endpoints=await request(apiPath('endpoints','nats','infrastructure'),{operation:'get/endpoints'});
   const addresses=[...new Set((endpoints.subsets||[]).flatMap(s=>(s.addresses||[]).map(a=>a.ip)))];
   if(!addresses.length)core.blocked('NATS_ENDPOINTS_PENDING');
   const lists=await Promise.all(addresses.map(async ip=>{if(!net.isIP(ip))core.blocked('NATS_ENDPOINT_CONTRACT');const d=await jsonRequest('http://'+(ip.includes(':')?'['+ip+']':ip)+':8222/connz?subs=1&limit=100000',{target:'nats-monitor',operation:'connz'});if(!Array.isArray(d.connections)||!Number.isInteger(d.total)||d.total!==d.connections.length)core.blocked('NATS_MONITOR_INCOMPLETE');return d.connections;}));
   return lists.flat();
  },
  async natsAvailable(d,secrets){const e=core.env(d.spec.template.spec.containers.find(c=>c.name===core.WELLKNOWN));const url=core.value(e,'WELLKNOWN_SERVICE_NATS_URL',secrets);if(!url)core.blocked('NATS_ENVIRONMENT_CONTRACT');return natsPing(url);}
 };
}
async function main(){
 const api=clusterApi();let status={ready:false,code:'GUARD_STARTING'},stopping=false;
 const server=http.createServer((req,res)=>{const ok=req.url==='/health'||(req.url==='/ready'&&status.ready);res.writeHead(req.url==='/status'||ok?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/health'?{active:!stopping}:status));});
 server.listen(8080,'0.0.0.0');for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopping=true;server.close();});
 let last='';
 while(!stopping){try{status=await core.reconcile(api);}catch(e){status=failureStatus(e);}
  const safe=JSON.stringify({...status,checkedAt:undefined});if(safe!==last){last=safe;console.log(safe);}await new Promise(resolve=>{const timer=setTimeout(resolve,15000);timer.unref();});
 }
}
if(require.main===module)main().catch(()=>{console.error('GUARD_FATAL');process.exitCode=1;});
module.exports={apiPath,jsonRequest,natsPing,clusterApi,failureStatus};
