'use strict';
const {gunzipSync}=require('node:zlib');
const {request}=require('./http.cjs');
const {normalizeOffer,offerUrl}=require('./offers.cjs');
const {fail,object,string,id}=require('./errors.cjs');
const {decode,summarize,overall,statusRef}=require('./credentials.cjs');
class Adapters {
 constructor(config,http){this.c=config;this.http=http;}
 headers(c){return {authorization:'Bearer '+c.token,'x-tenantid':c.tenant,'x-groupid':c.group,'x-group':this.c.cryptoGroup,'x-namespace':this.c.cryptoNamespace,'x-origin':this.c.publicOrigin};}
 call(c,name,path,method='GET',body){return this.http.call(name,path,{method,body,headers:this.headers(c),timeout:method==='GET'?5000:15000,responseType:name==='didcomm'&&path==='/admin/invitation'?'text':'json'});}
 storagePath(c){return '/v1/tenants/'+id(c.tenant)+'/storage/'+id(c.account)+'/credentials';}
 async records(c){
  const r=await this.call(c,'storage',this.storagePath(c),'POST',{id:'ocm-ui-all',input_descriptors:[{id:'all',constraints:{fields:[]}}]});
  if(!r||typeof r!=='object')fail(502,'UPSTREAM_PROTOCOL_ERROR');
  const entries={...(r.credentials||{})};
  if(r.groups!==undefined&&!Array.isArray(r.groups))fail(502,'UPSTREAM_PROTOCOL_ERROR');
  for(const group of r.groups||[])Object.assign(entries,group.credentials||{});
  if(Object.keys(entries).length>5000)fail(502,'UPSTREAM_RESULT_TOO_LARGE');
  return entries;
 }
 async list(c,q={}){
  const records=await this.records(c),pageSize=Math.min(100,Math.max(1,Number(q.pageSize)||25));
  let items=Object.entries(records).map(([key,raw])=>{try{return summarize(key,raw);}catch{return {id:key,format:'unknown',types:[],issuer:{id:null},subject:{id:null},status:{state:'not_checked'}};}});
  if(q.q){const search=string(q.q,0,200).toLowerCase();items=items.filter(x=>[x.id,x.issuer.id,x.subject.id,...x.types].some(v=>String(v||'').toLowerCase().includes(search)));}
  if(q.type)items=items.filter(x=>x.types.includes(q.type));
  const sort=q.sort||'id';if(!['id','issuedAt','expiresAt'].includes(sort))fail(400,'VALIDATION_ERROR');
  items.sort((a,b)=>String(a[sort]||'').localeCompare(String(b[sort]||'')));
  let offset=0;if(q.cursor){try{offset=Number(Buffer.from(q.cursor,'base64url').toString());}catch{fail(400,'VALIDATION_ERROR');}if(!Number.isSafeInteger(offset)||offset<0||offset>5000)fail(400,'VALIDATION_ERROR');}
  return {items:items.slice(offset,offset+pageSize),total:items.length,nextCursor:offset+pageSize<items.length?Buffer.from(String(offset+pageSize)).toString('base64url'):null,refreshedAt:new Date().toISOString()};
 }
 async raw(c,key){const all=await this.records(c);if(!Object.hasOwn(all,key))fail(404,'RESOURCE_NOT_FOUND');return all[key];}
 async detail(c,key){const raw=await this.raw(c,key);return {...summarize(key,raw),claims:decode(raw).claims,raw,provenance:{issuer:summarize(key,raw).issuer,holder:summarize(key,raw).subject,verifier:null,source:'credential-declarations',verified:false}};}
 async remove(c,key){await this.call(c,'storage',this.storagePath(c)+'/'+id(key),'DELETE');return {state:'succeeded',credentialId:key};}
 async absent(c,key){try{await this.raw(c,key);return null;}catch(e){if(e.status===404)return {state:'succeeded',credentialId:key};throw e;}}
 async readStatus(c,ref){
  const r=await this.call(c,'status','/v1/tenants/'+id(c.tenant)+'/status/'+id(ref.listId));
  if(typeof r?.list!=='string'||r.tenantId!==c.tenant||String(r.listId)!==ref.listId)fail(502,'UPSTREAM_PROTOCOL_ERROR');
  let bytes;try{bytes=gunzipSync(Buffer.from(r.list,'base64url'),{maxOutputLength:2097152});}catch{fail(502,'UPSTREAM_PROTOCOL_ERROR');}
  if(ref.index>=bytes.length*8)fail(502,'UPSTREAM_PROTOCOL_ERROR');
  return (bytes[Math.floor(ref.index/8)]&(1<<(7-(ref.index%8))))?'revoked':'active';
 }
 async verify(c,key){
  const raw=await this.raw(c,key),parsed=decode(raw),summary=summarize(key,raw);
  if(!['ldp_vc','dc+sd-jwt'].includes(parsed.format))return {credentialId:key,cryptographic:{state:'unsupported'},status:{state:'unknown'},overall:'unsupported'};
  let cryptographic='unknown',status=parsed.claims.credentialStatus||parsed.tokenClaims.status?'unknown':'not_required';
  try{
   const r=await this.http.call('signer','/v1/credential/verify',{method:'POST',headers:{...this.headers(c),'x-format':parsed.format},body:{credential:Buffer.from(typeof raw==='string'?raw:JSON.stringify(raw)).toString('base64')},timeout:10000});
   if(typeof r?.valid!=='boolean')fail(502,'UPSTREAM_PROTOCOL_ERROR');cryptographic=r.valid?'valid':'invalid';
  }catch(e){if(e.status<500)throw e;}
  if(status==='unknown'){try{status=await this.readStatus(c,statusRef(raw,this.c));}catch{/* Missing or remote status is truthfully indeterminate. */}}
  return {credentialId:key,format:parsed.format,cryptographic:{state:cryptographic},status:{state:status,checkedAt:new Date().toISOString()},overall:overall(cryptographic,status,Boolean(summary.expiresAt&&Date.parse(summary.expiresAt)<Date.now()))};
 }
 async revoke(c,key){
  const ref=statusRef(await this.raw(c,key),this.c);
  let state=await this.readStatus(c,ref);
  if(state!=='revoked'){
   await this.call(c,'status','/status/'+id(c.tenant)+'/'+id(ref.listId)+'/revoke/'+ref.index,'POST');
   state=await this.readStatus(c,ref);
  }
  if(state!=='revoked')fail(504,'OPERATION_OUTCOME_UNKNOWN');
  const verification=await this.verify(c,key);
  return {state:'succeeded',credentialId:key,status:'revoked',verification};
 }
 async revoked(c,key){const ref=statusRef(await this.raw(c,key),this.c);return (await this.readStatus(c,ref))==='revoked'?{state:'succeeded',credentialId:key,status:'revoked'}:null;}
 async chain(c,body){object(body,['root','chain','chainName']);string(body.root,1,512);string(body.chainName,1,128);if(!Array.isArray(body.chain)||body.chain.length>32)fail(400,'VALIDATION_ERROR');return {source:'declared_chain',result:await this.call(c,'storage',this.storagePath(c)+'/chain','POST',body)};}
 offerPath(c,action){return '/v1/tenants/'+id(c.tenant)+'/offering/'+action+'/'+id(c.group);}
 async offers(c){const r=await this.call(c,'retrieval',this.offerPath(c,'list'));if(r===null)return {items:[]};if(!Array.isArray(r))fail(502,'UPSTREAM_PROTOCOL_ERROR');return {items:r.map(o=>({requestId:o.requestId,issuer:o.metadata?.credential_issuer||o.offering?.credential_issuer,credentialConfigurationIds:o.offering?.credential_configuration_ids||o.offering?.credentials||[],state:o.status||'pending',receivedAt:o.timestamp}))};}
 async importOffer(c,offer){
  string(offer,1,16384);let payload=normalizeOffer(offer);
  const approved=value=>{let u;try{u=new URL(value);}catch{fail(400,'VALIDATION_ERROR');}if(u.protocol!=='https:'||u.username||u.password||!this.c.offerIssuerHosts.includes(u.hostname))fail(400,'OFFER_ISSUER_NOT_ALLOWED');return u;};
  if(payload.credential_offer_uri){
   const u=approved(string(payload.credential_offer_uri,1,4096));
   const downloaded=await request(u.toString(),{timeout:5000,maxBytes:16384});
   payload=normalizeOffer(downloaded);
   if(!payload.credential_offer)fail(400,'VALIDATION_ERROR');
  }
  string(payload.credential_offer,1,16000);
  let inner;try{inner=JSON.parse(payload.credential_offer);}catch{fail(400,'VALIDATION_ERROR');}
  approved(inner.credential_issuer);
  const result=await this.call(c,'retrieval',this.offerPath(c,'retrieve'),'PUT',{credential_offer:offerUrl(payload)});
  if(typeof result!=='string')fail(502,'UPSTREAM_PROTOCOL_ERROR');return {state:'succeeded',upstreamRequestId:result};
 }
 async accept(c,key,accept,body){
  object(body,['txCode']);if(body.txCode!==undefined)string(body.txCode,1,128);
  await this.call(c,'retrieval',this.offerPath(c,'clear')+'/'+id(key),'DELETE',{accept,holderKey:this.c.holderKey,holderNamespace:this.c.cryptoNamespace,holderGroup:this.c.cryptoGroup,...(body.txCode?{tx_code:body.txCode}:{})});
  // A clearance response is not proof that asynchronous storage has completed.
  return {state:'succeeded',upstreamRequestId:key,accepted:accept,storageConfirmation:'refresh-required'};
 }
 async relationship(c,key){
  const r=await this.call(c,'didcomm','/admin/connections/'+id(key));const m=r?.mediatee||r?.Mediatee||r;
  if(!m||m.group!==c.group)fail(404,'RESOURCE_NOT_FOUND');return m;
 }
 async relationships(c){const r=await this.call(c,'didcomm','/admin/connections?group='+id(c.group));if(!Array.isArray(r))fail(502,'UPSTREAM_PROTOCOL_ERROR');return {items:r.map(o=>o.mediatee||o.Mediatee||o).filter(o=>o.group===c.group).map(o=>({did:o.remoteDid,label:o.properties?.label||'',createdAt:o.added,group:o.group}))};}
 async relationAction(c,key,action,body){
  if(action==='invitations'){object(body,[]);return {state:'succeeded',invitation:await this.call(c,'didcomm','/admin/invitation','POST',{protocol:'nats',topic:this.c.didcommTopic,eventType:this.c.didcommEventType,properties:{},group:c.group})};}
  if(action==='accept'){
   object(body,['invitation']);string(body.invitation,1,16384);let u;try{u=new URL(body.invitation);}catch{fail(400,'INVALID_INVITATION_URL');}if(u.protocol!=='https:'||!this.c.relationshipHosts.includes(u.hostname))fail(400,'RELATIONSHIP_HOST_NOT_ALLOWED');
   return {state:'succeeded',peer:await this.call(c,'didcomm','/admin/connections/accept','POST',{invitation:body.invitation,protocol:'nats',topic:this.c.didcommTopic,eventType:this.c.didcommEventType,properties:{},group:c.group})};
  }
  const current=await this.relationship(c,key);
  if(action==='update'){object(body,['label']);string(body.label,0,128);await this.call(c,'didcomm','/admin/connections/'+id(key),'PUT',{remoteDid:current.remoteDid,routingKey:current.routingKey,protocol:current.protocol,topic:current.topic,eventType:current.eventType,recipientDids:current.recipientDids,group:c.group,properties:{...current.properties,label:body.label}});}
  else if(['block','unblock'].includes(action))await this.call(c,'didcomm','/admin/connections/'+action+'/'+id(key),'POST');
  else if(action==='delete')await this.call(c,'didcomm','/admin/connections/'+id(key),'DELETE');
  else fail(400,'VALIDATION_ERROR');
  return {state:'succeeded',resourceId:key};
 }
}
module.exports={Adapters};
