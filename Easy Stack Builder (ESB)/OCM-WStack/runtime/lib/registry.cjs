'use strict';
const {fail,object,string}=require('./errors.cjs');
const BUSINESS_TYPES=['ComplianceCredential','MembershipCredential','ParticipantCredential','ServiceOfferingCredential'];
function fields(value={}){
 object(value);const entries=Object.entries(value);if(entries.length>50)fail(400,'VALIDATION_ERROR');
 for(const [name,rule] of entries){
  if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)||['constructor','prototype','__proto__'].includes(name))fail(400,'VALIDATION_ERROR');
  object(rule,['required','maxLength']);if(typeof rule.required!=='boolean'||!Number.isInteger(rule.maxLength)||rule.maxLength<1||rule.maxLength>4096)fail(400,'VALIDATION_ERROR');
 }return value;
}
class Registry {
 constructor(db,events){this.collection=db.collection('credential_types');this.events=events;}
 async init(){await this.collection.createIndex({tenant:1,account:1,group:1,id:1},{unique:true});}
 scope(c){return {tenant:c.tenant,account:c.account,group:c.group};}
 async list(c){
  let native,nativeError;try{native=await this.events.types(c);}catch(e){native={items:[],source:'unavailable'};nativeError=e.code||'ISSUER_UNAVAILABLE';}
  const records=await this.collection.find(this.scope(c)).limit(1001).toArray();if(records.length>1000)fail(503,'REGISTRY_LIMIT');
  const nativeTypes=native.items||[],items=new Map(nativeTypes.map(x=>[x.id,{...x,name:x.id,description:'',issuerConfigurationId:x.id,revision:0,origin:'issuer',editable:true}]));
  for(const record of records){
   if(record.deleted){items.delete(record.id);continue;}
   const bound=nativeTypes.find(x=>x.id===record.definition.issuerConfigurationId);
   items.set(record.id,{...record.definition,id:record.id,revision:record.revision,origin:'registry',editable:true,format:bound?.format||record.definition.format,available:Boolean(bound&&bound.available!==false),demo:Boolean(bound?.demo),schema:bound?.schema||null});
  }
  for(const id of BUSINESS_TYPES)if(!items.has(id))items.set(id,{id,name:id,description:'',fields:{},issuerConfigurationId:id,revision:0,origin:'required-business-type',editable:false,available:false,blockedReason:'ISSUER_TEMPLATE_UNAVAILABLE',schema:null});
  return {items:[...items.values()],nativeTypes:nativeTypes.map(({id,format})=>({id,format})),source:native.source,...(nativeError?{nativeError}:{})};
 }
 validate(body){
  object(body,['id','name','description','format','issuerConfigurationId','fields','revision']);
  string(body.id,1,128);if(!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(body.id))fail(400,'VALIDATION_ERROR');
  string(body.name,1,128);string(body.description||'',0,1024);string(body.format||'',0,64);string(body.issuerConfigurationId||'',0,128);fields(body.fields);
  return {id:body.id,name:body.name,description:body.description||'',format:body.format||'',issuerConfigurationId:body.issuerConfigurationId||'',fields:body.fields||{}};
 }
 async change(c,id,body,remove=false){
  if(remove)object(body,['revision']);
  const definition=remove?null:this.validate(body),key=id||definition.id;
  if(id&&definition?.id!==undefined&&definition.id!==id)fail(400,'TYPE_ID_IMMUTABLE');
  const catalog=await this.list(c),current=catalog.items.find(x=>x.id===key),query={...this.scope(c),id:key};
  const old=await this.collection.findOne(query);
  if(!id&&(current||old&&!old.deleted))fail(409,'CREDENTIAL_TYPE_EXISTS');
  if(id&&!current)fail(404,'RESOURCE_NOT_FOUND');
  if(id&&(!Number.isInteger(body.revision)||body.revision!==current.revision))fail(409,'REGISTRY_CHANGED');
  if(definition?.issuerConfigurationId){const bound=catalog.nativeTypes.find(x=>x.id===definition.issuerConfigurationId);if(!bound)fail(422,'ISSUER_TEMPLATE_UNAVAILABLE');definition.format=bound.format||definition.format;}
  const next={definition,deleted:remove,revision:(old?.revision||0)+1,updatedAt:new Date(),updatedBy:c.subject};
  if(old){const result=await this.collection.updateOne({...query,revision:id?body.revision:old.revision},{$set:next});if(result.matchedCount!==1)fail(409,'REGISTRY_CHANGED');}
  else try{await this.collection.insertOne({...query,...next});}catch(e){if(e.code===11000)fail(409,'REGISTRY_CHANGED');throw e;}
  return {state:'succeeded',resourceId:key,revision:next.revision};
 }
 async issue(c,body,requestId){
  object(body,['credentialConfigurationId','claims']);
  const type=(await this.list(c)).items.find(x=>x.id===body.credentialConfigurationId);if(!type)fail(400,'UNKNOWN_CREDENTIAL_TYPE');
  if(type.available===false||!type.issuerConfigurationId)fail(422,'ISSUER_TEMPLATE_UNAVAILABLE');
  object(body.claims,Object.keys(type.fields||{}).length?Object.keys(type.fields):undefined);
  for(const [key,rule]of Object.entries(type.fields||{}))if(rule.required||body.claims[key]!==undefined)string(body.claims[key],rule.required?1:0,rule.maxLength||256);
  return this.events.issue(c,{...body,credentialConfigurationId:type.issuerConfigurationId},requestId);
 }
}
module.exports={Registry,fields};
