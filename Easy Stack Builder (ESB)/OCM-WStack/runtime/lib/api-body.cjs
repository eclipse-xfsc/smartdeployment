'use strict';
const {randomUUID}=require('node:crypto');
const MAX_BYTES=1024*1024;
// ORCE's HTTP-in chain runs JSON and raw parsers in sequence. Own parsing for
// this API and mark it consumed so differing body-parser versions cannot read
// the same stream again. Do not affect the editor, uibuilder or operator flows.
function parseApiBody(req,res,next){
 if(!/^\/orce\/ui-api\/v1(?:\/|$)/.test(req.originalUrl||req.url)||!['POST','PUT','PATCH','DELETE'].includes(req.method))return next();
 let ended=false,size=0,chunks=[],timer;
 const cleanup=()=>{clearTimeout(timer);req.removeListener('data',data);req.removeListener('end',end);req.removeListener('error',broken);req.removeListener('aborted',broken);};
 const reject=(status,code)=>{
  if(ended)return;ended=true;cleanup();req.resume();
  const requestId=randomUUID();res.setHeader('X-Request-Id',requestId);res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');
  res.statusCode=status;res.end(JSON.stringify({error:{code,requestId},requestId}));
 };
 const finish=body=>{if(ended)return;if(!body||typeof body!=='object'||Array.isArray(body))return reject(400,'INVALID_JSON_BODY');ended=true;cleanup();req.body=body;req._body=true;next();};
 const broken=()=>reject(400,'REQUEST_BODY_INTERRUPTED');
 function data(chunk){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=b.length;if(size>MAX_BYTES)return reject(413,'REQUEST_TOO_LARGE');chunks.push(b);}
 function end(){let body;try{body=size?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch{return reject(400,'INVALID_JSON_BODY');}finish(body);}
 if(req.headers['content-encoding']&&!/^identity$/i.test(req.headers['content-encoding']))return reject(415,'UNSUPPORTED_CONTENT_ENCODING');
 if(req.headers['content-type']&&!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']))return reject(415,'JSON_CONTENT_TYPE_REQUIRED');
 if(Number(req.headers['content-length'])>MAX_BYTES)return reject(413,'REQUEST_TOO_LARGE');
 if(req.body!==undefined&&(req._body||req.readableEnded)){
  if(typeof req.body==='string'||Buffer.isBuffer(req.body)){size=Buffer.byteLength(req.body);if(size>MAX_BYTES)return reject(413,'REQUEST_TOO_LARGE');chunks=[Buffer.from(req.body)];return end();}
  try{if(Buffer.byteLength(JSON.stringify(req.body))>MAX_BYTES)return reject(413,'REQUEST_TOO_LARGE');}catch{return reject(400,'INVALID_JSON_BODY');}
  return finish(req.body);
 }
 if(req.readableEnded){if(Number(req.headers['content-length'])>0||req.headers['transfer-encoding'])return reject(400,'REQUEST_BODY_UNAVAILABLE');return finish({});}
 timer=setTimeout(()=>reject(408,'REQUEST_BODY_TIMEOUT'),15000);timer.unref?.();
 req.on('data',data);req.once('end',end);req.once('error',broken);req.once('aborted',broken);
}
module.exports={parseApiBody,MAX_BYTES};
