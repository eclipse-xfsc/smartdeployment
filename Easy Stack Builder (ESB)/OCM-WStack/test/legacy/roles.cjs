'use strict';
const {Client}=require('../../runtime/lib/http.cjs');
const {atomic}=require('../../runtime/lib/permissions.cjs');
const {fail,object,string,id}=require('../../runtime/lib/errors.cjs');
class Roles {
 constructor(config,db,http){this.http=http||new Client({iam:config.keycloakInternal});this.c=config;this.db=db;this.token=null;this.client=null;}
 async call(path,method='GET',body){
  if(!this.token||this.until<Date.now()){
   const t=await this.http.call('iam','/realms/'+id(this.c.realm)+'/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:this.c.adminClientId,client_secret:this.c.adminClientSecret}).toString()});
   if(typeof t?.access_token!=='string')fail(503,'IAM_UNAVAILABLE');this.token=t.access_token;this.until=Date.now()+(t.expires_in-15)*1000;
  }
  return this.http.call('iam','/admin/realms/'+id(this.c.realm)+path,{method,body,headers:{authorization:'Bearer '+this.token}});
 }
 async clientId(){if(!this.client){const d=await this.call('/clients?clientId='+id(this.c.clientId));if(d.length!==1)fail(503,'IAM_UNAVAILABLE');this.client=d[0].id;}return this.client;}
 async base(){return '/clients/'+id(await this.clientId());}
 async list(){
  const base=await this.base(),raw=await this.call(base+'/roles?max=1000');
  if(raw.length>=1000)fail(503,'IAM_RESULT_LIMIT');
  const items=[];
  for(const role of raw){
   if(atomic.includes(role.name))items.push({...role,kind:'atomic',editable:false,permissions:[role.name]});
   else if(role.attributes?.['ocm-ui-managed']?.includes('true')){
    const c=await this.call(base+'/roles/'+id(role.name)+'/composites');
    items.push({...role,kind:'composite',editable:true,permissions:c.filter(x=>x.clientRole&&x.containerId===this.client&&atomic.includes(x.name)).map(x=>x.name)});
   }
  }return {items,atomic};
 }
 validate(body){
  object(body,['name','description','permissions']);
  string(body.name,1,64);if(!/^[a-z][a-z0-9-]{0,63}$/.test(body.name)||atomic.includes(body.name))fail(400,'VALIDATION_ERROR');
  if(body.description!==undefined)string(body.description,0,512);
  if(!Array.isArray(body.permissions)||body.permissions.some(p=>!atomic.includes(p))||new Set(body.permissions).size!==body.permissions.length)fail(400,'VALIDATION_ERROR');
 }
 async users(search=''){
  string(search,0,128);if(search&&search.length<2)fail(400,'VALIDATION_ERROR');
  const users=await this.call('/users?max=100'+(search?'&search='+id(search):''));
  const base=await this.base();const items=[];
  for(const user of users){if(user.serviceAccountClientId)continue;const roles=await this.call('/users/'+id(user.id)+'/role-mappings/clients/'+this.client);items.push({id:user.id,username:user.username,email:user.email||'',firstName:user.firstName||'',lastName:user.lastName||'',enabled:user.enabled,roles:roles.map(r=>({id:r.id,name:r.name}))});}
  return {items};
 }
 async user(uid,body,remove=false){return this.lock(async()=>{
  if(!remove){
   object(body,['username','email','firstName','lastName','enabled','temporaryPassword']);
   string(body.username,1,128);if(/\s/.test(body.username))fail(400,'VALIDATION_ERROR');
   for(const key of ['email','firstName','lastName'])if(body[key]!==undefined)string(body[key],0,256);
   if(body.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)||typeof body.enabled!=='boolean')fail(400,'VALIDATION_ERROR');
   if(!uid)string(body.temporaryPassword,12,256);else if(body.temporaryPassword!==undefined)fail(400,'VALIDATION_ERROR');
  }
  let old;if(uid){old=await this.call('/users/'+id(uid));if(old.serviceAccountClientId)fail(403,'SYSTEM_USER_PROTECTED');if(remove||!body.enabled)await this.protect({uid,assigned:[]});}
  if(remove){await this.call('/users/'+id(uid),'DELETE');return {state:'succeeded',resourceId:uid};}
  const value={username:body.username,email:body.email||'',firstName:body.firstName||'',lastName:body.lastName||'',enabled:body.enabled};
  if(uid){if(old.username!==body.username)fail(400,'USER_NAME_IMMUTABLE');await this.call('/users/'+id(uid),'PUT',{...value,...(old.email!==value.email?{emailVerified:false}:{})});}
  else{await this.call('/users','POST',{...value,requiredActions:['UPDATE_PASSWORD'],credentials:[{type:'password',value:body.temporaryPassword,temporary:true}]});}
  return {state:'succeeded',...(uid?{resourceId:uid}:{}),refreshRequired:true};
 });}
 async effective(uid){const base=await this.base();return (await this.call('/users/'+id(uid)+'/role-mappings/clients/'+this.client+'/composite')).filter(r=>atomic.includes(r.name)).map(r=>r.name);}
 async lock(fn){
  const locks=this.db.collection('coordination_locks'),key='roles:'+this.c.realm;
  try{await locks.insertOne({_id:key,createdAt:new Date()});}catch{fail(409,'ROLE_CHANGE_IN_PROGRESS');}
  // Deliberately no expiring lease: a crashed mutation requires operator inspection.
  try{return await fn();}finally{await locks.deleteOne({_id:key});}
 }
 async protect({roleId,replacement,uid,assigned}){
  const all=[];let offset=0;
  while(true){const page=await this.call('/users?first='+offset+'&max=100');all.push(...page);if(page.length<100)break;offset+=100;if(offset>5000)fail(503,'IAM_RESULT_LIMIT');}
  const roles=(await this.list()).items;
  const after=new Map(roles.map(r=>[r.id,r.id===roleId?replacement:r.permissions]));
  for(const user of all){
   if(!user.enabled||user.serviceAccountClientId)continue;
   const direct=user.id===uid?assigned:await this.call('/users/'+id(user.id)+'/role-mappings/clients/'+this.client);
   if(direct.some(r=>(after.get(r.id)||[]).includes('admin.users')))return;
  }
  fail(409,'LAST_ROLE_MANAGER');
 }
 async change(roleId,body,remove=false){return this.lock(async()=>{
  if(!remove)this.validate(body);
  const base=await this.base(),roles=(await this.list()).items,old=roleId?roles.find(r=>r.id===roleId):null;
  if(roleId&&(!old||!old.editable))fail(403,'SYSTEM_ROLE_PROTECTED');
  if(old)await this.protect({roleId,replacement:remove?[]:body.permissions});
  if(remove){await this.call(base+'/roles/'+id(old.name),'DELETE');return {state:'succeeded',resourceId:roleId};}
  if(old&&old.name!==body.name)fail(400,'ROLE_RENAME_REQUIRES_NEW_ROLE');
  if(!old){if(roles.some(r=>r.name===body.name))fail(409,'ROLE_EXISTS');await this.call(base+'/roles','POST',{name:body.name,description:body.description||'',composite:true,attributes:{'ocm-ui-managed':['true']}});}
  const role=await this.call(base+'/roles/'+id(body.name));
  const current=await this.call(base+'/roles/'+id(body.name)+'/composites');
  const wanted=roles.filter(r=>r.kind==='atomic'&&body.permissions.includes(r.name));
  // Add before remove, reducing temporary privilege loss. Both remain narrowly scoped.
  const add=wanted.filter(r=>!current.some(x=>x.id===r.id));
  if(add.length)await this.call(base+'/roles/'+id(body.name)+'/composites','POST',add.map(({id,name})=>({id,name})));
  const drop=current.filter(r=>!wanted.some(x=>x.id===r.id));if(drop.length)await this.call(base+'/roles/'+id(body.name)+'/composites','DELETE',drop);
  await this.call(base+'/roles/'+id(body.name),'PUT',{...role,description:body.description||'',attributes:{...role.attributes,'ocm-ui-managed':['true']}});
  return {state:'succeeded',resourceId:role.id,refreshRequired:true};
 });}
 async assign(uid,body){return this.lock(async()=>{
  object(body,['roleIds']);if(!Array.isArray(body.roleIds)||body.roleIds.length>50)fail(400,'VALIDATION_ERROR');
  const roles=(await this.list()).items,wanted=body.roleIds.map(k=>roles.find(r=>r.id===k));if(wanted.some(r=>!r))fail(400,'VALIDATION_ERROR');
  await this.protect({uid,assigned:wanted});
  const path='/users/'+id(uid)+'/role-mappings/clients/'+this.client,old=await this.call(path);
  const add=wanted.filter(r=>!old.some(x=>x.id===r.id));if(add.length)await this.call(path,'POST',add.map(({id,name})=>({id,name})));
  const drop=old.filter(r=>roles.some(x=>x.id===r.id)&&!wanted.some(x=>x.id===r.id));if(drop.length)await this.call(path,'DELETE',drop);
  return {state:'succeeded',resourceId:uid,refreshRequired:true};
 });}
}
module.exports={Roles};
