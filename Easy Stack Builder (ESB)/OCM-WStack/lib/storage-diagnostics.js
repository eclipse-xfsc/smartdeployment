'use strict';

// Runs inside the existing OCM UI Pod and reads public configuration.
// file; filter POST is the native read-only credential-list operation.
const probe=String.raw`
const credentialsPath=${require('../runtime/lib/storage-path.cjs').credentialsPath.toString()};
const fs=require('node:fs'),http=require('node:http'),https=require('node:https');
const c=JSON.parse(fs.readFileSync(process.env.OCM_RUNTIME_CONFIG||'/data/config.json','utf8'));
const base=new URL(c.services.storage);
const credentialPath=credentialsPath(c);
async function read(path,method='GET'){
 return new Promise(resolve=>{
  const body=undefined;
  const req=(base.protocol==='https:'?https:http).request(new URL(path,base),{method,headers:{accept:'application/json','x-tenantid':c.tenant,'x-groupid':c.group,...(method==='POST'?{'content-type':'application/json','content-length':'0'}:{})}},res=>{
   let bytes=0,chunks=[];
   res.on('data',chunk=>{bytes+=chunk.length;if(bytes>2097152)req.destroy(Object.assign(new Error(),{code:'RESPONSE_TOO_LARGE'}));else chunks.push(chunk);});
   res.on('error',()=>resolve({path,method,error:'RESPONSE_INTERRUPTED'}));
   res.on('end',()=>{
    const result={path,method,httpStatus:res.statusCode};
    try{const data=JSON.parse(Buffer.concat(chunks));
     result.responseShape=data===null?'null':Array.isArray(data)?'array':typeof data;
     if(['Region Id Missing.','Country Id Missing.','Tenant Id Missing.','Account Id Missing.'].includes(data.message))result.nativeMessage=data.message;
     if(path==='/swagger/doc.json'){result.basePath=data.basePath;result.storagePaths=Object.keys(data.paths||{}).sort();}
    }catch{}
    resolve(result);
   });
  });
  const timer=setTimeout(()=>req.destroy(Object.assign(new Error(),{code:'TIMEOUT'})),10000);
  req.on('close',()=>clearTimeout(timer));req.on('error',e=>resolve({path,method,error:['TIMEOUT','ECONNREFUSED','ENOTFOUND','RESPONSE_TOO_LARGE'].includes(e.code)?e.code:'REQUEST_FAILED'}));req.end(body);
 });
}
(async()=>{
 const checks=await Promise.all([read('/v1/metrics/health'),read('/swagger/doc.json'),read(credentialPath,'POST')]);
 // Exercise the installed OCM adapter.
 // Never load runtime secrets, user tokens or output credential contents.
 try{
  const {Adapters}=require('/data/lib/adapters.cjs'),{Client}=require('/data/lib/http.cjs');
  const records=await new Adapters(c,new Client(c.services)).records({...c,token:''});
  checks.push({name:'wallet-adapter-list',state:'passed',credentialCount:Object.keys(records).length});
 }catch(e){checks.push({name:'wallet-adapter-list',state:'failed',code:e.code||'ADAPTER_DIAGNOSTIC_FAILED',...(e.reason?{reason:e.reason}:{}),...(e.upstreamStatus?{httpStatus:e.upstreamStatus}:{})});}
 let runtimeVersion;try{runtimeVersion=require('/data/current/package.json').version;}catch{}
 console.log(JSON.stringify({runtimeVersion,credentialPath,checks}));
})().catch(()=>{console.error('STORAGE_DIAGNOSTIC_FAILED');process.exitCode=1;});
`;

async function diagnose(r){
 const pods=await r.json('kubectl',['-n','ocm-wstack','get','pods','-o','json']);
 const images=(pods.items||[]).filter(p=>p.metadata.name.startsWith('storage-service-')&&!p.metadata.deletionTimestamp).map(p=>({pod:p.metadata.name,containers:(p.status?.containerStatuses||[]).map(x=>({name:x.name,image:x.image,imageID:x.imageID,ready:x.ready}))}));
 const result=await r.run('kubectl',['-n','ocm-wstack','exec','-i','deployment/ocm-orce','-c','orce','--','node','-'],{input:probe,timeout:20000});
 return {images,...JSON.parse(result.stdout)};
}
module.exports={diagnose,probe};
