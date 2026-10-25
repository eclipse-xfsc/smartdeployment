'use strict';
const {randomUUID,createHash,randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
const {fail}=require('./errors.cjs');
function canonical(x){if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';return JSON.stringify(x);}
class Coordination {
 constructor(db,key){this.db=db;this.key=key?Buffer.from(key,'hex'):null;}
 seal(value){if(!this.key)fail(503,'ENCRYPTION_UNAVAILABLE');const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return {iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')};}
 open(value){const d=createDecipheriv('aes-256-gcm',this.key,Buffer.from(value.iv,'base64'));d.setAuthTag(Buffer.from(value.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(value.data,'base64')),d.final()]));}
 publicJob(job){const {encryptedOffer,encryptedResult,_id,key,requestHash,...publicData}=job;return {...publicData,...(encryptedOffer?{offer:this.open(encryptedOffer)}:{}),...(encryptedResult?this.open(encryptedResult):{})};}
 async init(){
  await this.db.collection('operation_jobs').createIndex({tenant:1,subject:1,account:1,group:1,operation:1,key:1},{unique:true});
  await this.db.collection('operation_jobs').createIndex({expiresAt:1},{expireAfterSeconds:0});
  await this.db.collection('operation_jobs').createIndex({requestId:1},{unique:true});
  await this.db.collection('audit_events').createIndex({expiresAt:1},{expireAfterSeconds:0});
  await this.db.collection('audit_events').createIndex({tenant:1,timestamp:-1});
  await this.db.collection('verification_events').createIndex({expiresAt:1},{expireAfterSeconds:0});
  await this.db.collection('verification_events').createIndex({tenant:1,account:1,group:1,credentialId:1,timestamp:-1});
  await this.db.collection('ui_preferences').createIndex({tenant:1,subject:1},{unique:true});
 }
 scope(c){return {tenant:c.tenant,subject:c.subject,account:c.account,group:c.group};}
 async audit(c,action,outcome,requestId,code=null){
  await this.db.collection('audit_events').insertOne({eventId:randomUUID(),...this.scope(c),actor:{subject:c.subject,username:c.username||null},action,outcome,requestId,code,timestamp:new Date(),expiresAt:new Date(Date.now()+90*86400000),schemaVersion:2});
 }
 async run(c,operation,key,body,fn,reconcile){
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(key))fail(400,'IDEMPOTENCY_KEY_REQUIRED');
  const query={...this.scope(c),operation,key},hash=createHash('sha256').update(canonical(body)).digest('hex');
  const jobs=this.db.collection('operation_jobs');
  const job={...query,requestHash:hash,requestId:randomUUID(),state:'dispatching',createdAt:new Date(),expiresAt:new Date(Date.now()+72*3600000),schemaVersion:1};
  try{await jobs.insertOne(job);}catch(e){
   if(e.code!==11000)fail(503,'COORDINATION_UNAVAILABLE');
   const old=await jobs.findOne(query);if(!old||old.requestHash!==hash)fail(409,'IDEMPOTENCY_KEY_REUSED');
   if(old.state==='failed')fail(409,old.code||'OPERATION_FAILED');
   if(old.state==='unknown'&&reconcile){const result=await reconcile();if(result){await jobs.updateOne(query,{$set:{state:'succeeded',result,updatedAt:new Date()}});return {...result,requestId:old.requestId};}}
   return {requestId:old.requestId,state:old.state,...(old.result||{}),...(old.encryptedOffer?{offer:this.open(old.encryptedOffer)}:{}),...(old.encryptedResult?this.open(old.encryptedResult):{}),replayed:true};
  }
  // Must be durable before any side effect. Payloads/tokens/claims never persist.
  await this.audit(c,operation,'started',job.requestId);
  try{
   const result=await fn(job.requestId);
   // Only explicitly selected metadata goes to Mongo. Never arbitrary upstream results.
   const safe={state:result.state||'succeeded'};
   for(const k of ['resourceId','credentialId','upstreamRequestId','overall','code'])if(typeof result[k]==='string')safe[k]=result[k].slice(0,512);
   if(typeof result.accepted==='boolean')safe.accepted=result.accepted;
   if(['confirmed','unconfirmed'].includes(result.storageConfirmation))safe.storageConfirmation=result.storageConfirmation;
   if(Array.isArray(result.credentialIds)&&result.credentialIds.length<=32&&result.credentialIds.every(k=>typeof k==='string'&&k.length<=512))safe.credentialIds=result.credentialIds;
   await jobs.updateOne(query,{$set:{state:safe.state,result:safe,...(result.offer?{encryptedOffer:this.seal(result.offer)}:{}),...(result.invitation?{encryptedResult:this.seal({invitation:result.invitation})}:{}),updatedAt:new Date()}});
   await this.audit(c,operation,safe.state,job.requestId);
   return {...result,requestId:job.requestId};
  }catch(e){
   const state=!e.dispatchNotStarted&&(!e.status||e.status>=500)&&!['NATS_REQUIRED_FOR_ISSUANCE','VALIDATION_ERROR','ISSUER_INITIALIZING','ISSUER_TENANT_CONFIGURATION_CONFLICT','ISSUANCE_NO_RESPONDERS'].includes(e.code)?'unknown':'failed';
   await jobs.updateOne(query,{$set:{state,code:e.code||'INTERNAL_ERROR',updatedAt:new Date()}});
   await this.audit(c,operation,state,job.requestId,e.code||'INTERNAL_ERROR');e.operationId=job.requestId;e.operationState=state;throw e;
  }
 }
}
module.exports={Coordination,canonical};
