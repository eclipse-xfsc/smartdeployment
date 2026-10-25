'use strict';
const {Adapters}=require('./adapters.cjs');
const {request}=require('./http.cjs');
const {normalizeOffer,offerUrl}=require('./offers.cjs');
const {fail,object,string,id}=require('./errors.cjs');
class PcmAdapters extends Adapters {
 constructor(config,http){super({...config,tenant:config.pcm.tenant,publicOrigin:config.pcm.accountUrl?new URL(config.pcm.accountUrl).origin:config.publicOrigin,issuerDids:[],cryptoNamespace:config.pcm.cryptoNamespace},http);this.pcm=config.pcm;}
 async statusConfiguration(c){
  if(!this.pcm.services?.status)return this.c;
  // Only a DID owned by the signed-in personal account can authorize a native
  // status mutation. An organizational issuer must never confer that authority.
  let keys;try{keys=await this.keys(c);}catch{return this.c;}
  return {...this.c,issuerDids:keys.items.map(k=>k.did).filter(d=>typeof d==='string'&&d.startsWith('did:'))};
 }
 accountPath(path){return '/v1/tenants/'+id(this.pcm.tenant)+'/api/accounts'+path;}
 accountCall(c,path,method='GET',body){return this.http.call('pcm',this.accountPath(path),{method,body,headers:{authorization:'Bearer '+c.token},timeout:15000});}
 call(c,name,path,method,body){if(!this.pcm.services?.[name])fail(422,'PCM_NATIVE_ENDPOINT_REQUIRED');return super.call(c,name,path,method,body);}
 headers(c){return {...super.headers(c),'x-group':c.account};}
 async records(c){return this.unpack(await this.accountCall(c,'/credentials/list','POST',{}));}
 async detail(c,key){const d=await super.detail(c,key);d.capabilities.delete=Boolean(this.pcm.services?.storage);d.capabilities.verify=Boolean(this.pcm.services?.signer);d.capabilities.revoke=d.capabilities.revoke&&Boolean(this.pcm.services?.status);return d;}
 async verify(c,key){if(!this.pcm.services?.signer)fail(422,'PCM_NATIVE_ENDPOINT_REQUIRED');return super.verify(c,key);}
 async remove(c,key){await this.raw(c,key);return super.remove(c,key);}
 async keys(c){const r=await this.accountCall(c,'/kms/did/list');if(!Array.isArray(r?.list))fail(502,'UPSTREAM_PROTOCOL_ERROR');return {items:r.list.map(k=>({id:k.id,did:k.did}))};}
 async offers(c){const r=await this.accountCall(c,'/credentials/offers/list');if(r===null)return {items:[]};if(!Array.isArray(r))fail(502,'UPSTREAM_PROTOCOL_ERROR');return {items:r.map(o=>({requestId:o.requestId,issuer:o.metadata?.credential_issuer||o.offering?.credential_issuer,credentialConfigurationIds:o.offering?.credential_configuration_ids||o.offering?.credentials||[],state:o.status||'pending',receivedAt:o.timestamp}))};}
 async importOffer(c,offer){
  // Reuse the organizational issuer allow-list and validation before sending
  // the offer to the user's own Account Service. Never use organization tokens.
  const adapter=new Adapters(this.c,{call:async(name,path,o)=>this.accountCall(c,'/credentials/offers/create','PUT',o.body)});
  return adapter.importOffer(c,offer);
 }
 async accept(c,key,accept,body){
  object(body,['txCode','holderKey']);
  if(!accept){await this.accountCall(c,'/credentials/offers/'+id(key)+'/deny','POST',{});return {state:'succeeded',accepted:false,upstreamRequestId:key};}
  const keys=await this.keys(c),holder=body.holderKey||keys.items[0]?.id;
  if(!holder||!keys.items.some(k=>k.id===holder))fail(422,'PCM_HOLDER_KEY_REQUIRED');
  if(body.txCode){
   if(!this.pcm.services?.retrieval)fail(422,'PCM_TX_CODE_REQUIRES_RETRIEVAL');
   return new Adapters({...this.c,holderKey:holder,cryptoGroup:c.account},this.http).accept(c,key,true,{txCode:body.txCode});
  }
  await this.accountCall(c,'/credentials/offers/'+id(key)+'/accept','POST',{keyId:holder});
  return {state:'succeeded',accepted:true,upstreamRequestId:key,storageConfirmation:'refresh-required'};
 }
 async types(c){const m=await this.accountCall(c,'/credentials/schemas');if(!m||typeof m!=='object'||Array.isArray(m))fail(502,'UPSTREAM_PROTOCOL_ERROR');return {source:'pcm-issuer-metadata',items:Object.entries(m).map(([id,t])=>({id,identifier:id,format:t.format,types:t.credential_definition?.type||[],fields:{},schema:t.schema||null,available:true,demo:['DeveloperCredential','SDJWTCredential'].includes(id)}))};}
 async issue(c,body){object(body,['credentialConfigurationId','claims']);object(body.claims);const types=await this.types(c);if(!types.items.some(t=>t.id===body.credentialConfigurationId))fail(400,'UNKNOWN_CREDENTIAL_TYPE');if(Buffer.byteLength(JSON.stringify(body.claims))>65536)fail(413,'CLAIMS_TOO_LARGE');const offer=await this.accountCall(c,'/credentials/issue','POST',{type:body.credentialConfigurationId,payload:body.claims});normalizeOffer(offer);return {state:'succeeded',offer,credentialConfigurationId:body.credentialConfigurationId};}
}
class PcmIdentity {
 constructor(config,fetcher=request){this.c=config;this.fetch=fetcher;}
 async context(org,header){
  if(!this.c.pcm?.enabled)fail(409,'PCM_NOT_CONFIGURED');
  if(!/^Bearer [^ ]{1,16384}$/.test(header||''))fail(401,'PCM_AUTHENTICATION_REQUIRED');
  let user;try{user=await this.fetch(this.c.pcm.userInfo,{headers:{authorization:header},maxBytes:65536,timeout:5000});}catch{fail(401,'PCM_AUTHENTICATION_REQUIRED');}
  string(user?.sub,1,256);
  return {...org,tenant:this.c.pcm.tenant,account:user.sub,group:user.sub,token:header.slice(7),pcm:true,pcmSubject:user.sub};
 }
}
module.exports={PcmAdapters,PcmIdentity};
