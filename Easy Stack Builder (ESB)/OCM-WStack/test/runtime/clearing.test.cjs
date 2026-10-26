'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Clearing,ENDPOINT,GRANT,REQUIRED}=require('../../runtime/lib/clearing.cjs');
const {Coordination}=require('../../runtime/lib/coordination.cjs');
const jwt=require('../../runtime/lib/clearing-jwt.cjs');
const {publicAddress,httpsUrl}=require('../../runtime/lib/clearing-transport.cjs');
const {memoryDb}=require('../helpers/memory-db.cjs');
const c={tenant:'t',subject:'user',account:'a',group:'g',permissions:['clearing.request','credentials.read','credentials.receive']};
const keys=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'}),publicKey={...keys.publicKey.export({format:'jwk'}),kid:'signing'};
const did='did:web:compliance-dispatcher.lab.gaia-x.eu:v3',issuerDid='did:web:issuer.example';
const now=()=>Math.floor(Date.now()/1000);
function signed(payload,typ='vc+jwt',kid=issuerDid+'#signing'){
 const part=[{typ,alg:'ES256',kid},payload].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
 return part+'.'+crypto.sign('sha256',Buffer.from(part),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
function credential(type){return signed({'@context':['https://www.w3.org/ns/credentials/v2'],id:'urn:uuid:'+type,type:['VerifiableCredential',type],issuer:issuerDid,credentialSubject:{id:'did:web:company.example'},iat:now(),exp:now()+3600});}
async function fixture(options={}){
 const db=memoryDb(),coordination=new Coordination(db,'ab'.repeat(32));await coordination.init();
 const inputs=Object.fromEntries(REQUIRED.map(x=>[x.id,credential(x.type)]));
 const stored={...inputs};const calls=[];let imports=0;
 const metadata={credential_issuer:ENDPOINT,credential_endpoint:ENDPOINT+'/oid4vci/credentials',nonce_endpoint:ENDPOINT+'/oid4vci/nonce',notification_endpoint:ENDPOINT+'/oid4vci/notification',authorization_servers:[ENDPOINT],credential_configurations_supported:{ComplianceCredential:{format:'jwt_vc_json',credential_definition:{type:['VerifiableCredential','gx:ComplianceCredential']},proof_types_supported:{jwt:{proof_signing_alg_values_supported:['ES256']}}}}};
 const auth={issuer:ENDPOINT,token_endpoint:ENDPOINT+'/oid4vci/token',grant_types_supported:[GRANT]};
 const requestClaims={iss:did,aud:'https://self-issued.me/v2',client_id:'decentralized_identifier:'+did,response_type:'vp_token',response_mode:'direct_post',response_uri:ENDPOINT+'/oid4vp/callback',nonce:'nonce',state:'state',iat:now(),exp:now()+300,dcql_query:{credentials:REQUIRED.map(x=>({...x,format:'jwt_vc_json',require_cryptographic_holder_binding:false,meta:{type_values:[['VerifiableCredential',x.type]]}}))}};
 const issued=credential('gx:ComplianceCredential');
 const request=async(url,o={})=>{
  calls.push({url,o});if(options.failAt&&url.endsWith(options.failAt))throw Object.assign(Error('private upstream text'),{code:'CLEARING_TIMEOUT',status:504});
  if(url.endsWith('/.well-known/openid-credential-issuer'))return options.metadata||metadata;
  if(url.endsWith('/.well-known/oauth-authorization-server'))return auth;
  if(url.includes('/oid4vp/authorize?'))return 'openid4vp://?'+new URLSearchParams({client_id:'decentralized_identifier:'+did,request_uri:options.requestUri||ENDPOINT+'/oid4vp/request.jwt?state=state'});
  if(url.includes('/oid4vp/request.jwt?'))return options.requestToken||signed({...requestClaims,...options.requestClaims},'oauth-authz-req+jwt',did+'#signing');
  if(url.endsWith('/.well-known/jwks.json'))return {keys:[publicKey]};
  if(url.endsWith('/oid4vp/callback')){
   assert.equal(o.headers['content-type'],'application/x-www-form-urlencoded');
   const form=new URLSearchParams(o.body);assert.equal(form.get('state'),'state');
   assert.deepEqual(JSON.parse(form.get('vp_token')),Object.fromEntries(REQUIRED.map(x=>[x.id,[inputs[x.id]]])));
   return {redirect_uri:'openid-credential-offer://?'+new URLSearchParams({credential_offer:JSON.stringify({credential_issuer:options.offerIssuer||ENDPOINT,credential_configuration_ids:['ComplianceCredential'],grants:{[GRANT]:{'pre-authorized_code':'one-use-code'}}})})};
  }
  if(url.endsWith('/oid4vci/token')){assert.deepEqual(Object.fromEntries(new URLSearchParams(o.body)),{grant_type:GRANT,'pre-authorized_code':'one-use-code'});return {access_token:'secret-access-token',token_type:'Bearer',expires_in:300};}
  if(url.endsWith('/oid4vci/nonce'))return {c_nonce:'fresh-nonce'};
  if(url.endsWith('/oid4vci/credentials')){
   assert.equal(o.headers.authorization,'Bearer secret-access-token');assert.deepEqual(Object.keys(o.body),['credential_configuration_id','proofs']);
   const proof=o.body.proofs.jwt[0],decoded=jwt.decode(proof);assert.equal(decoded.header.jwk.d,undefined);
   const claims=jwt.verify(proof,decoded.header.jwk,'openid4vci-proof+jwt');assert.equal(claims.aud,ENDPOINT);assert.equal(claims.nonce,'fresh-nonce');
   return {credentials:[{credential:options.issued||issued}],notification_id:'notification'};
  }
  if(url==='https://issuer.example/.well-known/did.json')return {id:issuerDid,verificationMethod:[{id:issuerDid+'#signing',controller:issuerDid,publicKeyJwk:publicKey}],assertionMethod:[issuerDid+'#signing']};
  if(url.endsWith('/oid4vci/notification')){assert.equal(stored['job-1'],issued);return null;}
  throw Error('unexpected URL '+url);
 };
 const adapters={records:async()=>stored,raw:async(ctx,id)=>stored[id],importCredential:async(ctx,{credential},id)=>{imports++;if(options.storageFailure)throw Object.assign(Error(),{code:'UPSTREAM_UNAVAILABLE'});stored[id]=credential;}};
 const clearing=new Clearing({}, {request});await clearing.init(db,adapters,coordination);
 const body={provider:'gaia-x',credentials:Object.fromEntries(REQUIRED.map(x=>[x.id,x.id]))};
 return {clearing,body,db,calls,stored,options,imports:()=>imports,run:async()=>{await clearing.acquire(c,body,'job-1');await clearing.close();return clearing.get(c,'job-1');}};
}
test('Dispatcher final OID exchange verifies signatures, uses a nonce proof, stores exact bytes and notifies after readback',async()=>{
 const f=await fixture();const result=await f.run();assert.equal(result.state,'succeeded');assert.equal(result.storageConfirmation,'confirmed');assert.equal(f.imports(),1);assert.equal(result.notification,'accepted');
 const rows=JSON.stringify([...f.db.tables]);for(const secret of ['secret-access-token','one-use-code',f.stored['job-1']])assert.ok(!rows.includes(secret));
 assert.equal((await f.clearing.history(c)).items.length,1);
});
test('provider metadata controls availability and excludes incompatible endpoints',async()=>{
 const f=await fixture({metadata:{credential_issuer:'https://evil.example'}});assert.equal((await f.clearing.list()).items[0].requestSupported,false);await assert.rejects(f.clearing.acquire(c,f.body,'job-1'),{code:'CLEARING_METADATA_INVALID'});
 assert.equal(f.calls.filter(x=>x.o.method==='POST').length,0);
});
test('credential choices include only the required unexpired VC 2.0 JWT types',async()=>{
 const f=await fixture();f.stored.legacy=JSON.stringify({type:['VerifiableCredential','gx:LegalPerson']});f.stored.expired=signed({'@context':['https://www.w3.org/ns/credentials/v2'],type:['VerifiableCredential','gx:LegalPerson'],exp:now()-1});
 assert.equal((await f.clearing.inputs(c)).items[0].credentials.length,1);
});
for(const field of ['subject','tenant','account','group'])test('Clearing job is inaccessible across '+field,async()=>{
 const f=await fixture();await f.run();await assert.rejects(f.clearing.get({...c,[field]:'other'},'job-1'),{code:'RESOURCE_NOT_FOUND'});
});
test('request, credential choices and job reads require read, receive and Clearing permissions',async()=>{
 const f=await fixture();for(const permission of c.permissions){const denied={...c,permissions:c.permissions.filter(p=>p!==permission)};await assert.rejects(f.clearing.acquire(denied,f.body,'job-1'),{code:'PERMISSION_DENIED'});await assert.rejects(f.clearing.inputs(denied),{code:'PERMISSION_DENIED'});}
 assert.equal(f.calls.length,0);
});
for(const requestClaims of [{response_uri:'https://evil.example/callback'},{state:'other'},{exp:now()-1},{nonce:''},{dcql_query:{credentials:[]}}])test('reject signed request contract mismatch '+JSON.stringify(requestClaims),async()=>{
 const f=await fixture({requestClaims});assert.equal((await f.run()).state,'failed');assert.ok(!f.calls.some(x=>x.url.endsWith('/oid4vp/callback')));
});
test('request_uri cannot redirect disclosure to another origin',async()=>{const f=await fixture({requestUri:'https://evil.example/v3/oid4vp/request.jwt?state=state'});assert.equal((await f.run()).state,'failed');assert.ok(f.calls.every(x=>!x.url.startsWith('https://evil.example')));});
test('foreign offer issuer is rejected before sending the pre-authorized code',async()=>{const f=await fixture({offerIssuer:'https://evil.example'});assert.equal((await f.run()).state,'unknown');assert.ok(!f.calls.some(x=>x.url.endsWith('/oid4vci/token')));});
test('consumed token request is never retried after ambiguous timeout',async()=>{const f=await fixture({failAt:'/oid4vci/credentials'});const result=await f.run();assert.equal(result.state,'unknown');assert.equal(f.calls.filter(x=>x.url.endsWith('/oid4vci/credentials')).length,1);assert.equal(f.imports(),0);});
test('received credential survives a storage outage encrypted and retries storage without requesting another credential',async()=>{
 const f=await fixture({storageFailure:true});assert.equal((await f.run()).state,'received');assert.ok(f.db.tables.get('clearing_jobs')[0].encryptedCredential);const count=f.calls.length;f.options.storageFailure=false;const saved=await f.clearing.store(c,'job-1');assert.equal(saved.state,'succeeded');assert.equal(f.calls.length,count);assert.equal((await f.clearing.store(c,'job-1')).state,'succeeded');assert.equal(f.imports(),2);
});
test('forged returned credential is not stored',async()=>{const original=credential('gx:ComplianceCredential'),parts=original.split('.');parts[1]=Buffer.from(JSON.stringify({...jwt.decode(original).payload,credentialSubject:{id:'foreign'}})).toString('base64url');const f=await fixture({issued:parts.join('.')});const result=await f.run();assert.equal(result.code,'CLEARING_SIGNATURE_INVALID');assert.equal(f.imports(),0);});
test('job interrupted by runtime restart becomes unknown without replaying network operations',async()=>{const f=await fixture();await f.db.collection('clearing_jobs').insertOne({id:'stale',...f.clearing.scope(c),state:'pending',deadline:new Date(0)});assert.equal((await f.clearing.get(c,'stale')).state,'unknown');assert.equal(f.calls.length,0);});
test('coordination replays the same job ID without dispatching a second exchange',async()=>{
 const f=await fixture(),coord=f.clearing.coordination,key='idempotency-key-123';const execute=id=>f.clearing.acquire(c,f.body,id);
 const one=await coord.run(c,'clearingRequest',key,f.body,execute);const two=await coord.run(c,'clearingRequest',key,f.body,execute);assert.equal(two.resourceId,one.resourceId);await f.clearing.close();assert.equal(f.calls.filter(x=>x.url.includes('/oid4vp/authorize?')).length,1);
});
test('public transport rejects private, mapped, loopback and documentation addresses',()=>{
 for(const address of ['127.0.0.1','10.1.2.3','100.64.2.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(address),false,address);
 assert.equal(publicAddress('104.16.11.34'),true);assert.equal(publicAddress('2606:4700::1111'),true);
 for(const url of ['http://example.com','https://example.com:8443','https://127.0.0.1','https://user:pass@example.com','https://example.com/#token'])assert.throws(()=>httpsUrl(url));
});
