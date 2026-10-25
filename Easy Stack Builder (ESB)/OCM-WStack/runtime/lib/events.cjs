'use strict';
const {EventEmitter}=require('node:events');
const {fail,object,string}=require('./errors.cjs');
class Events extends EventEmitter {
 constructor(config,bootstrap){super();this.bootstrap=bootstrap;this.c=config;this.connected=false;this.nc=null;this.stopping=false;this.timer=null;}
 async start(){
  const {connect}=require('nats');
  try{
   this.nc=await connect({servers:this.c.natsUrl,timeout:3000,maxReconnectAttempts:-1,reconnectTimeWait:2000,name:'ocm-ui-runtime',...(this.c.natsUser?{user:this.c.natsUser,pass:this.c.natsPassword}:{})});
   this.connected=true;this.emit('hint',{type:'resync',requiresRefresh:true});
   (async()=>{for await(const s of this.nc.status()){if(this.stopping)break;this.connected=s.type==='reconnect'||s.type==='update'?true:s.type==='disconnect'?false:this.connected;if(['reconnect','disconnect'].includes(s.type))this.emit('hint',{type:'resync',requiresRefresh:true});}})().catch(()=>{});
   for(const entry of this.c.eventSubjects||[]){
    // Only explicit observer subjects. No command subjects and no queue group.
    if(!/^ui\.events\.[A-Za-z0-9_.-]+$/.test(entry.subject))throw Error('Unsafe observer subject');
    const sub=this.nc.subscribe(entry.subject);
    (async()=>{for await(const msg of sub){try{if(msg.data.length>65536)continue;const e=JSON.parse(Buffer.from(msg.data));if(e.specversion!=='1.0'||e.data?.tenant_id!==this.c.tenant||e.data?.group_id!==this.c.group)continue;this.emit('hint',{type:entry.type,requiresRefresh:true});}catch{}}})().catch(()=>{});
   }
  }catch{this.connected=false;if(!this.stopping)this.timer=setTimeout(()=>this.start(),5000);}
 }
 async issue(c,body,requestId){
  object(body,['credentialConfigurationId','claims']);const type=this.c.credentialTypes.find(t=>t.id===body.credentialConfigurationId);if(!type)fail(400,'UNKNOWN_CREDENTIAL_TYPE');
  object(body.claims,Object.keys(type.fields));
  for(const [key,field] of Object.entries(type.fields)){if(field.required||body.claims[key]!==undefined)string(body.claims[key],field.required?1:0,field.maxLength||256);}
  if(!this.connected||!this.nc)fail(503,'NATS_REQUIRED_FOR_ISSUANCE');
  if(this.bootstrap){try{await this.bootstrap.ensure();}catch(e){e.dispatchNotStarted=true;throw e;}}
  const event={specversion:'1.0',id:requestId,source:'urn:xfsc:ocm-ui',type:'issuance.request',time:new Date().toISOString(),datacontenttype:'application/json',data:{tenant_id:c.tenant,group_id:c.group,request_id:requestId,identifier:type.identifier,payload:body.claims}};
  let reply;try{reply=await this.nc.request(type.subject,Buffer.from(JSON.stringify(event)),{timeout:10000});}catch(e){if(e.code==='503')fail(503,'ISSUANCE_NO_RESPONDERS');fail(504,'OPERATION_OUTCOME_UNKNOWN');}
  if(reply.data.length>65536)fail(502,'UPSTREAM_PROTOCOL_ERROR');
  let rep;try{rep=JSON.parse(Buffer.from(reply.data));if(rep.data)rep=rep.data;}catch{fail(502,'UPSTREAM_PROTOCOL_ERROR');}
  if(rep.request_id!==requestId||rep.tenant_id!==c.tenant||(rep.group_id&&rep.group_id!==c.group))fail(502,'UPSTREAM_PROTOCOL_ERROR');
  if(rep.error)fail(502,'ISSUANCE_REJECTED');
  if(!rep.offer||typeof rep.offer!=='object')fail(502,'UPSTREAM_PROTOCOL_ERROR');
  this.emit('hint',{type:'offers.changed',requiresRefresh:true});
  return {state:'succeeded',offer:rep.offer,credentialConfigurationId:type.id};
 }
 async close(){this.stopping=true;clearTimeout(this.timer);if(this.nc)await this.nc.drain();}
}
module.exports={Events};
