'use strict';
const {id,fail}=require('./errors.cjs');
class IssuerBootstrap {
 constructor(config,http){this.c=config;this.http=http;this.readyAfter=0;this.timer=null;this.pending=null;this.state='unchecked';}
 async ensure(){
  if(this.pending)return this.pending;
  this.pending=this.reconcile();
  try{return await this.pending;}finally{this.pending=null;}
 }
 async reconcile(){
  const path='/internal/tenants/'+id(this.c.tenant);
  const expected={credentialIssuer:this.c.publicOrigin,authorizationServers:[this.c.publicOrigin],credentialEndpoint:this.c.publicOrigin+'/api/issuance/credential'};
  let current;
  try{current=await this.http.call('issuerBootstrap',path);}catch(e){if(e.upstreamStatus!==404){this.state='unavailable';throw e;}}
  if(!current){
   await this.http.call('issuerBootstrap',path,{method:'PUT',body:expected});
   // The content signer publishes tenant metadata every 30 seconds.
   this.readyAfter=Date.now()+35000;this.state='initializing';
  }else if(current.credentialIssuer!==expected.credentialIssuer||current.credentialEndpoint!==expected.credentialEndpoint||JSON.stringify(current.authorizationServers)!==JSON.stringify(expected.authorizationServers)){
   this.state='configuration-conflict';fail(503,'ISSUER_TENANT_CONFIGURATION_CONFLICT');
  }
  if(Date.now()<this.readyAfter){this.state='initializing';fail(503,'ISSUER_INITIALIZING');}
  this.state='registered';
 }
 start(){this.ensure().catch(()=>{});this.timer=setInterval(()=>this.ensure().catch(()=>{}),30000);this.timer.unref?.();}
 close(){clearInterval(this.timer);}
}
module.exports={IssuerBootstrap};
