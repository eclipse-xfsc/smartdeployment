'use strict';
const {Adapters}=require('./adapters.cjs');
const {request}=require('./http.cjs');
const {fail,object,string,id}=require('./errors.cjs');

class PcmAdapters extends Adapters {
 constructor(config,http){super({...config,tenant:config.pcm.tenant},http);this.pcm=config.pcm;}
 accountPath(path){return '/v1/tenants/'+id(this.pcm.tenant)+'/api/accounts'+path;}
 accountCall(c,path,method='GET',body){return this.http.call('pcm',this.accountPath(path),{method,body,headers:{authorization:'Bearer '+c.token},timeout:15000});}
 async records(c){return this.unpack(await this.accountCall(c,'/credentials/list','POST',{}));}
 // PCM's delete/revoke handlers are stubs. Reuse actual native Storage and
 // Status List operations, scoped to the authenticated PCM subject.
 async remove(c,key){await this.raw(c,key);return super.remove(c,key);}
 async keys(c){const r=await this.accountCall(c,'/kms/did/list');if(!Array.isArray(r?.list))fail(502,'UPSTREAM_PROTOCOL_ERROR');return {items:r.list.map(k=>({id:k.id,did:k.did}))};}
 async accept(c,key,accept,body){
  object(body,['txCode','holderKey']);
  if(!accept)return super.accept(c,key,false,{});
  const keys=await this.keys(c);
  const holder=body.holderKey||keys.items[0]?.id;
  if(!holder||!keys.items.some(k=>k.id===holder))fail(422,'PCM_HOLDER_KEY_REQUIRED');
  // Account Service drops tx_code. Use the same Retrieval API with the key
  // verified against this user's Account Service key inventory.
  const adapter=new Adapters({...this.c,holderKey:holder,cryptoNamespace:this.pcm.cryptoNamespace,cryptoGroup:c.account},this.http);
  return adapter.accept(c,key,accept,body.txCode?{txCode:body.txCode}:{});
 }
}

class PcmIdentity {
 constructor(config,fetcher=request){this.c=config;this.fetch=fetcher;}
 async context(org,header){
  if(!this.c.pcm?.enabled)fail(409,'PCM_NOT_CONFIGURED');
  if(!/^Bearer [^ ]{1,16384}$/.test(header||''))fail(401,'PCM_AUTHENTICATION_REQUIRED');
  const token=header.slice(7);
  // The trusted OIDC userinfo endpoint validates the token. No account ID is
  // accepted from the browser and no organizational service token is used.
  let user;try{user=await this.fetch(this.c.pcm.userInfo,{headers:{authorization:header},maxBytes:65536,timeout:5000});}catch{fail(401,'PCM_AUTHENTICATION_REQUIRED');}
  string(user?.sub,1,256);
  return {...org,tenant:this.c.pcm.tenant,account:user.sub,group:user.sub,token,pcm:true,pcmSubject:user.sub};
 }
}
module.exports={PcmAdapters,PcmIdentity};
