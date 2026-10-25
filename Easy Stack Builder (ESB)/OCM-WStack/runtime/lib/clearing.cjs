'use strict';
const {createHash}=require('node:crypto');
const {request}=require('./http.cjs');
const {fail,object}=require('./errors.cjs');
const {decode}=require('./credentials.cjs');
const WIZARD='https://wizard.lab.gaia-x.eu';
const providers=[{id:'gaia-lab',name:'Gaia-X Lab',environment:'test',url:WIZARD+'/',guide:WIZARD+'/userGuide',requestSupported:true}];
function registryProviders(data){
 if(!data||typeof data!=='object'||Array.isArray(data))fail(502,'CLEARING_REGISTRY_UNAVAILABLE');
 const result=[];
 for(const [category,values]of Object.entries(data)){
  if(!/compliance/i.test(category)||!Array.isArray(values))continue;
  for(const value of values){
   if(typeof value!=='string')continue;let url;try{url=new URL(value.startsWith('https://')?value:'https://'+value);}catch{continue;}
   if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.pathname.includes('/v2')||url.hostname.includes('lab.gaia-x'))continue;
   result.push({id:createHash('sha256').update(url.href).digest('hex').slice(0,20),name:url.hostname,environment:'production',url:WIZARD+'/',guide:WIZARD+'/userGuide',requestSupported:true,complianceEndpoint:url.href.replace(/^https:\/\//,'').replace(/\/$/,''),source:'gaia-x-trusted-issuers'});
  }
 }
 return [...new Map(result.map(p=>[p.id,p])).values()];
}
class Clearing {
 constructor(fetcher=request){this.fetch=fetcher;this.catalog=null;this.checkedAt=0;}
 async list(){
  if(this.catalog&&Date.now()-this.checkedAt<300000)return this.catalog;
  let extra=[],registryAvailable=true;try{extra=registryProviders(await this.fetch(WIZARD+'/api/clearing-houses',{timeout:8000,maxBytes:262144}));}catch{registryAvailable=false;}
  this.checkedAt=Date.now();this.catalog={items:[...extra,...providers],checkedAt:new Date(this.checkedAt).toISOString(),registryAvailable,source:WIZARD+'/api/clearing-houses',directory:'https://gaia-x.eu/services-deliverables/digital-clearing-house/'};return this.catalog;
 }
 async acquire(body){
  object(body,['provider','verifiablePresentation']);const list=await this.list(),provider=list.items.find(p=>p.id===body.provider);
  if(!provider?.requestSupported)fail(422,'CLEARING_PROVIDER_UNAVAILABLE');
  const vp=body.verifiablePresentation;
  if(!vp||(typeof vp!=='string'&&typeof vp!=='object')||Buffer.byteLength(JSON.stringify(vp))>524288)fail(400,'SIGNED_PRESENTATION_REQUIRED');
  // Forward the signed presentation. Exclude the OCM bearer token,
  // TLS private key, or private signing key is sent to the provider.
  const r=await this.fetch(WIZARD+'/api/credential-offers',{method:'POST',body:{...(provider.complianceEndpoint?{clearingHouse:provider.complianceEndpoint}:{}),verifiablePresentation:vp},timeout:30000,maxBytes:1048576});
  const value=r?.jwt||r?.data;if(!value)fail(502,'CLEARING_RESPONSE_UNSUPPORTED');
  const context={state:'succeeded',provider:provider.id,environment:provider.environment};
  if(value.credential_offer||value.credential_offer_uri)return {...context,offer:value};
  const parsed=decode(value),types=parsed.claims.type;
  if(!parsed.tokenClaims.iss&&!(Array.isArray(types)&&types.includes('VerifiableCredential'))&&types!=='VerifiableCredential')fail(502,'CLEARING_RESPONSE_UNSUPPORTED');
  return {...context,credential:value,stored:false};
 }
}
module.exports={Clearing,providers,registryProviders};
