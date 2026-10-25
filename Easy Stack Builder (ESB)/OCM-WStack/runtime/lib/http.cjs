'use strict';
const http=require('node:http'),https=require('node:https');
const {AppError}=require('./errors.cjs');
// No redirects, ambient credentials, raw upstream error bodies, or mutation retries.
function request(url,{method='GET',headers={},body,timeout=5000,maxBytes=2097152,responseType='json'}={}) {
 return new Promise((resolve,reject)=>{
  let u;try{u=new URL(url);}catch{return reject(new AppError(500,'CONFIGURATION_ERROR'));}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return reject(new AppError(500,'CONFIGURATION_ERROR'));
  const data=body===undefined?undefined:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  const req=(u.protocol==='https:'?https:http).request(u,{method,headers:{accept:'application/json',...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
   let size=0,chunks=[];
   res.on('data',b=>{size+=b.length;if(size>maxBytes)req.destroy(new AppError(502,'UPSTREAM_RESPONSE_TOO_LARGE'));else chunks.push(b);});
   res.on('end',()=>{
    if(res.statusCode<200||res.statusCode>=300)return reject(new AppError(res.statusCode===404?404:res.statusCode>=500?503:502,res.statusCode===404?'RESOURCE_NOT_FOUND':'UPSTREAM_REJECTED'));
    const raw=Buffer.concat(chunks).toString();if(!raw)return resolve(null);if(responseType==='text')return resolve(raw);
    try{resolve(JSON.parse(raw));}catch{reject(new AppError(502,'UPSTREAM_PROTOCOL_ERROR'));}
   });
   res.on('error',()=>reject(new AppError(503,'UPSTREAM_UNAVAILABLE')));
  });
  const timer=setTimeout(()=>req.destroy(new AppError(504,'UPSTREAM_TIMEOUT')),timeout);
  req.on('close',()=>clearTimeout(timer));req.on('error',e=>reject(e instanceof AppError?e:new AppError(503,'UPSTREAM_UNAVAILABLE')));
  req.end(data);
 });
}
class Client {
 constructor(urls){this.urls=urls;this.states=new Map();}
 async call(name,path,options={}){
  if(!path.startsWith('/')||path.startsWith('//'))throw new AppError(500,'CONFIGURATION_ERROR');
  let state=this.states.get(name)||{failures:0,openUntil:0};this.states.set(name,state);
  if(state.openUntil>Date.now())throw new AppError(503,'UPSTREAM_CIRCUIT_OPEN');
  try{const r=await request(this.urls[name]+path,options);state.failures=0;state.openUntil=0;state.lastSuccessAt=new Date().toISOString();return r;}
  catch(e){state.lastErrorCode=e.code; if(e.status>=500&&++state.failures>=3)state.openUntil=Date.now()+30000;throw e;}
 }
 health(){return [...this.states].map(([name,s])=>({name,circuit:s.openUntil>Date.now()?'open':'closed',lastSuccessAt:s.lastSuccessAt||null,lastErrorCode:s.lastErrorCode||null}));}
}
module.exports={request,Client};
