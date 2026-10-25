'use strict';
const {EventEmitter}=require('node:events');
const {fail,object,string}=require('./errors.cjs');
function hintFromEvent(data,entry,config){
 if(data.length>65536)return null;
 try{const e=JSON.parse(Buffer.from(data));if(e.specversion!=='1.0'||(entry.eventType&&e.type!==entry.eventType)||e.data?.tenant_id!==config.tenant||e.data?.group_id!==config.group)return null;return {type:entry.type,requiresRefresh:true};}catch{return null;}
}
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
    if(entry.subject!=='retrieval.offering.publication'&&!/^ui\.events\.[A-Za-z0-9_.-]+$/.test(entry.subject))throw Error('Unsafe observer subject');
    const sub=this.nc.subscribe(entry.subject);
    (async()=>{for await(const msg of sub){const hint=hintFromEvent(msg.data,entry,this.c);if(hint)this.emit('hint',hint);}})().catch(()=>{});
   }
  }catch{this.connected=false;if(!this.stopping)this.timer=setTimeout(()=>this.start(),5000);}
 }
 async types(c){
  let items=this.c.credentialTypes.map(t=>({...t,demo:true})),source='configured';
  if(this.connected&&this.nc){
   const requestId=require('node:crypto').randomUUID();
   try{
    const message={specversion:'1.0',id:requestId,source:'urn:xfsc:ocm-ui',type:'wellknown.issuer.metadata',datacontenttype:'application/json',data:{tenant_id:c.tenant,request_id:requestId}};
    const reply=await this.nc.request('wellknown.issuer.metadata',Buffer.from(JSON.stringify(message)),{timeout:5000});
    if(reply.data.length>262144)fail(502,'UPSTREAM_RESPONSE_TOO_LARGE');
    const outer=JSON.parse(Buffer.from(reply.data)),data=outer.data||outer;
    if(data.request_id!==requestId||data.tenant_id!==c.tenant)fail(502,'UPSTREAM_PROTOCOL_ERROR');
    const metadata=data.Issuer||data.issuer;
    if(metadata?.credential_configurations_supported){
     items=Object.entries(metadata.credential_configurations_supported).map(([id,m])=>{
      const fallback=this.c.credentialTypes.find(t=>t.id===id),topic=m.topic;
      const subject=typeof topic==='string'&&/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(topic)?(topic.endsWith('.request')?topic:topic+'.request'):fallback?.subject;
      return {id,identifier:id,subject,fields:fallback?.fields||{},schema:m.schema||null,format:m.format,types:m.credential_definition?.type||[],demo:Boolean(fallback),available:Boolean(subject)};
     });source='issuer-metadata';
    }
   }catch(e){if(!['503','TIMEOUT'].includes(e.code))throw e;}
  }
  this.catalog={tenant:c.tenant,items,at:Date.now()};
  return {items:items.map(({subject,...t})=>t),source};
 }
 async issue(c,body,requestId){
  object(body,['credentialConfigurationId','claims']);const catalog=this.catalog?.tenant===c.tenant&&Date.now()-this.catalog.at<60000?this.catalog.items:this.c.credentialTypes;const type=catalog.find(t=>t.id===body.credentialConfigurationId);if(!type)fail(400,'UNKNOWN_CREDENTIAL_TYPE');
  if(!this.connected||!this.nc)fail(503,'NATS_REQUIRED_FOR_ISSUANCE');
  if(!type.subject)fail(422,'ISSUER_TEMPLATE_UNAVAILABLE');
  object(body.claims,Object.keys(type.fields).length?Object.keys(type.fields):undefined);
  if(Buffer.byteLength(JSON.stringify(body.claims))>65536)fail(413,'CLAIMS_TOO_LARGE');
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
module.exports={Events,hintFromEvent};
