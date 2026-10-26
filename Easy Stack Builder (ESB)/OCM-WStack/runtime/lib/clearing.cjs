"use strict";

const {fail,object,string}=require('./errors.cjs');
const transport=require('./clearing-transport.cjs');
const jwt=require('./clearing-jwt.cjs');
const ENDPOINT='https://compliance-dispatcher.lab.gaia-x.eu/v3';
const GRANT='urn:ietf:params:oauth:grant-type:pre-authorized_code';
const REQUIRED=[
  {id:'gaiax-legal-person',type:'gx:LegalPerson'},
  {id:'gaiax-vat-id',type:'gx:VatID'},
  {id:'gaiax-terms-and-conditions',type:'gx:Issuer'}
];
const TERMINAL=['succeeded','failed','unknown','received'];
function requirePermissions(c){if(!['clearing.request','credentials.read','credentials.receive'].every(p=>c.permissions?.includes(p)))fail(403,'PERMISSION_DENIED');}
function inputClaims(raw,type){
  const {header,payload}=jwt.decode(raw);
  if(header.typ!=='vc+jwt'||payload.vc||!Array.isArray(payload.type)||!payload.type.includes('VerifiableCredential')||!payload.type.includes(type)||!payload['@context']?.includes('https://www.w3.org/ns/credentials/v2'))fail(422,'CLEARING_INPUT_FORMAT');
  for(const field of ['validFrom','validUntil'])if(payload[field]!==undefined){const date=Date.parse(payload[field]);if(!Number.isFinite(date)||(field==='validFrom'?date>Date.now():date<=Date.now()))fail(422,'CLEARING_CREDENTIAL_EXPIRED');}
  if(payload.exp!==undefined&&(!Number.isFinite(payload.exp)||payload.exp<=Date.now()/1000))fail(422,'CLEARING_CREDENTIAL_EXPIRED');
  return payload;
}
class Clearing {
  constructor(config={},dependencies={}){
    this.base=(config.clearingCenter?.url||ENDPOINT).replace(/\/$/,'');
    const url=transport.httpsUrl(this.base);if(url.search||url.pathname==='/'||url.href.replace(/\/$/,'')!==this.base)fail(500,'CLEARING_ENDPOINT_INVALID');
    this.request=dependencies.request||transport.request;
    this.running=new Map();this.cache=null;
  }
  async init(db,adapters,coordination){
    this.jobs=db.collection('clearing_jobs');this.adapters=adapters;this.coordination=coordination;
    await this.jobs.createIndex({id:1},{unique:true});
    await this.jobs.createIndex({expiresAt:1},{expireAfterSeconds:0});
  }
  scope(c){return {tenant:c.tenant,account:c.account,group:c.group,subject:c.subject};}
  async metadata(){
    if(this.cache&&this.cache.until>Date.now())return this.cache.value;
    const issuer=await this.request(this.base+'/.well-known/openid-credential-issuer');
    const auth=await this.request(this.base+'/.well-known/oauth-authorization-server');
    const configuration=issuer?.credential_configurations_supported?.ComplianceCredential;
    if(issuer?.credential_issuer!==this.base||auth?.issuer!==this.base||issuer.credential_endpoint!==this.base+'/oid4vci/credentials'||issuer.nonce_endpoint!==this.base+'/oid4vci/nonce'||auth.token_endpoint!==this.base+'/oid4vci/token'||!issuer.authorization_servers?.includes(this.base)||!auth.grant_types_supported?.includes(GRANT)||configuration?.format!=='jwt_vc_json'||!configuration.proof_types_supported?.jwt?.proof_signing_alg_values_supported?.includes('ES256')||!configuration.credential_definition?.type?.includes('gx:ComplianceCredential'))fail(502,'CLEARING_METADATA_INVALID');
    this.cache={until:Date.now()+60000,value:{issuer,auth}};return this.cache.value;
  }
  async list(){
    let code=null;try{await this.metadata();}catch(e){code=e.code||'CLEARING_CONNECTION_FAILED';}
    return {items:[{id:'gaia-x',name:'Gaia-X Clearing Center',url:this.base,protocol:'OID4VP / OID4VCI',trustScope:'GX_LOIRE_COMPLIANCE',requestSupported:!code,state:code?'unavailable':'available',code,requirements:REQUIRED}]};
  }
  async inputs(c){
    requirePermissions(c);const records=await this.adapters.records(c);
    return {items:REQUIRED.map(requirement=>({...requirement,credentials:Object.entries(records).flatMap(([id,raw])=>{try{const claims=inputClaims(raw,requirement.type);return [{id,credentialId:claims.id||null}];}catch{return [];}})}))};
  }
  public(job){
    return Object.fromEntries(['id','provider','state','phase','code','httpStatus','credentialId','storageConfirmation','notification','createdAt','updatedAt'].filter(k=>job[k]!==undefined).map(k=>[k,job[k]]));
  }
  async find(c,id){
    requirePermissions(c);string(id,1,128);const query={...this.scope(c),id};
    let job=await this.jobs.findOne(query);if(!job)fail(404,'RESOURCE_NOT_FOUND');
    // An interrupted exchange must never silently replay a consumed code or nonce.
    if(!TERMINAL.includes(job.state)&&new Date(job.deadline).getTime()<Date.now()){
      await this.jobs.updateOne({...query,state:job.state},{$set:{state:'unknown',code:'CLEARING_INTERRUPTED',updatedAt:new Date()}});
      job=await this.jobs.findOne(query);
    }
    return job;
  }
  async get(c,id){return this.public(await this.find(c,id));}
  async history(c){
    requirePermissions(c);const rows=await this.jobs.find(this.scope(c)).sort({createdAt:-1}).limit(20).toArray();
    return {items:await Promise.all(rows.map(row=>this.get(c,row.id)))};
  }
  async update(c,id,fields){
    await this.jobs.updateOne({...this.scope(c),id},{$set:{...fields,updatedAt:new Date()}});
  }
  async acquire(c,body,id){
    requirePermissions(c);object(body,['provider','credentials']);
    if(body.provider!=='gaia-x')fail(400,'VALIDATION_ERROR');
    object(body.credentials,REQUIRED.map(x=>x.id));
    const records=await this.adapters.records(c),selected={};let vcid;
    for(const requirement of REQUIRED){
      const key=string(body.credentials[requirement.id],1,512);
      if(!Object.hasOwn(records,key))fail(404,'RESOURCE_NOT_FOUND');
      const raw=records[key],claims=inputClaims(raw,requirement.type);
      if(requirement.id==='gaiax-legal-person')vcid=string(claims.id,1,2048);
      selected[requirement.id]=raw;
    }
    await this.metadata();
    const now=new Date();
    await this.jobs.insertOne({id,...this.scope(c),provider:'gaia-x',state:'pending',phase:'authorizing',createdAt:now,updatedAt:now,deadline:new Date(Date.now()+5*60000),expiresAt:new Date(Date.now()+72*3600000)});
    // Persist the job before scheduling network mutations. Only IDs and progress are public.
    const task=new Promise(resolve=>setImmediate(resolve)).then(()=>this.exchange(c,id,selected,vcid));
    this.running.set(id,task);task.finally(()=>this.running.delete(id)).catch(()=>{});
    return {state:'pending',resourceId:id};
  }
  async form(path,body,options={}){return this.request(this.base+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body).toString(),...options});}
  async exchange(c,id,selected,vcid){
    let dispatched=false,issued=false;
    try{
      const {issuer}=await this.metadata();
      const link=await this.request(this.base+'/oid4vp/authorize?'+new URLSearchParams({trustScope:'GX_LOIRE_COMPLIANCE',vcid,complianceLevel:'standard-compliance'}),{text:true});
      let url;try{url=new URL(link);}catch{fail(502,'CLEARING_REQUEST_INVALID');}
      const did='did:web:'+new URL(this.base).host+new URL(this.base).pathname.replaceAll('/',':');
      const clientId='decentralized_identifier:'+did;
      if(url.protocol!=='openid4vp:'||url.searchParams.get('client_id')!==clientId)fail(502,'CLEARING_REQUEST_INVALID');
      const requestUrl=transport.httpsUrl(url.searchParams.get('request_uri'));
      if(requestUrl.origin+requestUrl.pathname!==this.base+'/oid4vp/request.jwt'||!requestUrl.searchParams.get('state'))fail(502,'CLEARING_REQUEST_INVALID');
      const requestToken=await this.request(requestUrl.href,{text:true});
      const keys=await this.request(this.base+'/.well-known/jwks.json');
      const {header}=jwt.decode(requestToken);
      const candidates=(keys?.keys||[]).filter(key=>key.kid===header.kid||key.kid===header.kid?.split('#')[1]);
      if(candidates.length!==1)fail(422,'CLEARING_ISSUER_KEY_UNAVAILABLE');
      const request=jwt.verify(requestToken,candidates[0],'oauth-authz-req+jwt');
      if(request.iss!==did||request.client_id!==clientId||request.aud!=='https://self-issued.me/v2'||request.response_type!=='vp_token'||request.response_mode!=='direct_post'||request.response_uri!==this.base+'/oid4vp/callback'||request.state!==requestUrl.searchParams.get('state')||typeof request.nonce!=='string'||!request.nonce||!Number.isFinite(request.exp)||!Number.isFinite(request.iat)||request.exp-request.iat>600)fail(422,'CLEARING_REQUEST_INVALID');
      const queries=request.dcql_query?.credentials;
      if(!Array.isArray(queries)||queries.length!==REQUIRED.length||request.dcql_query.credential_sets)fail(422,'CLEARING_QUERY_UNSUPPORTED');
      for(const expected of REQUIRED){const query=queries.find(x=>x.id===expected.id);if(!query||query.format!=='jwt_vc_json'||query.require_cryptographic_holder_binding!==false||query.multiple||query.claims||JSON.stringify(query.meta?.type_values)!==JSON.stringify([['VerifiableCredential',expected.type]]))fail(422,'CLEARING_QUERY_UNSUPPORTED');}
      await this.update(c,id,{phase:'presenting'});dispatched=true;
      const callback=await this.form('/oid4vp/callback',{state:request.state,vp_token:JSON.stringify(Object.fromEntries(REQUIRED.map(x=>[x.id,[selected[x.id]]])))},{timeout:90000});
      let offer;try{const uri=new URL(callback.redirect_uri);if(uri.protocol!=='openid-credential-offer:'||uri.searchParams.has('credential_offer_uri'))throw Error();offer=JSON.parse(uri.searchParams.get('credential_offer'));}catch{fail(502,'CLEARING_OFFER_INVALID');}
      const grant=offer?.grants?.[GRANT];
      if(offer?.credential_issuer!==this.base||JSON.stringify(offer.credential_configuration_ids)!=='["ComplianceCredential"]'||!grant||grant.tx_code||typeof grant['pre-authorized_code']!=='string'||!grant['pre-authorized_code'])fail(502,'CLEARING_OFFER_INVALID');
      await this.update(c,id,{phase:'receiving'});
      const token=await this.form('/oid4vci/token',{grant_type:GRANT,'pre-authorized_code':grant['pre-authorized_code']});
      if(typeof token?.access_token!=='string'||!/^[\x21-\x7e]+$/.test(token.access_token)||token.token_type?.toLowerCase()!=='bearer')fail(502,'CLEARING_TOKEN_INVALID');
      const nonce=await this.request(issuer.nonce_endpoint,{method:'POST'});
      if(typeof nonce?.c_nonce!=='string'||!nonce.c_nonce)fail(502,'CLEARING_NONCE_INVALID');
      const result=await this.request(issuer.credential_endpoint,{method:'POST',headers:{authorization:'Bearer '+token.access_token},body:{credential_configuration_id:'ComplianceCredential',proofs:{jwt:[jwt.proof(this.base,nonce.c_nonce)]}}});
      if(!Array.isArray(result?.credentials)||result.credentials.length!==1||typeof result.credentials[0]?.credential!=='string')fail(502,'CLEARING_CREDENTIAL_INVALID');
      const credential=result.credentials[0].credential;
      await this.update(c,id,{phase:'verifying'});
      await jwt.credential(credential,this.request);
      await this.update(c,id,{state:'received',phase:'storing',encryptedCredential:this.coordination.seal(credential)});issued=true;
      await this.store(c,id);
      if(issuer.notification_endpoint===this.base+'/oid4vci/notification'&&typeof result.notification_id==='string'){
        try{await this.request(issuer.notification_endpoint,{method:'POST',headers:{authorization:'Bearer '+token.access_token},body:{notification_id:result.notification_id,event:'credential_accepted'}});await this.update(c,id,{notification:'accepted'});}catch{await this.update(c,id,{notification:'unconfirmed'});}
      }
    }catch(e){
      const state=issued?'received':dispatched?'unknown':'failed';
      await this.update(c,id,{state,code:e.code||'CLEARING_REQUEST_FAILED',...(e.upstreamStatus?{httpStatus:e.upstreamStatus}:{})}).catch(()=>{});
      await this.coordination.audit(c,'clearingRequest',state,id,e.code||'CLEARING_REQUEST_FAILED').catch(()=>{});
    }
  }
  async store(c,id){
    const job=await this.find(c,id);if(job.state==='succeeded')return this.public(job);
    if(job.state!=='received'||!job.encryptedCredential)fail(409,'CLEARING_CREDENTIAL_NOT_RECEIVED');
    const raw=this.coordination.open(job.encryptedCredential);
    await this.coordination.audit(c,'clearingStore','started',id);
    const records=await this.adapters.records(c);
    if(Object.hasOwn(records,id)&&records[id]!==raw)fail(409,'CLEARING_STORAGE_CONFLICT');
    if(!Object.hasOwn(records,id))await this.adapters.importCredential(c,{credential:raw},id);
    if(await this.adapters.raw(c,id)!==raw)fail(502,'CLEARING_STORAGE_UNCONFIRMED');
    await this.coordination.audit(c,'clearingStore','succeeded',id);
    await this.jobs.updateOne({...this.scope(c),id},{$set:{state:'succeeded',phase:'complete',credentialId:id,storageConfirmation:'confirmed',updatedAt:new Date()},$unset:{encryptedCredential:'',code:'',httpStatus:''}});
    return this.get(c,id);
  }
  async close(){await Promise.allSettled(this.running.values());}
}
module.exports={Clearing,ENDPOINT,REQUIRED,GRANT,inputClaims};
