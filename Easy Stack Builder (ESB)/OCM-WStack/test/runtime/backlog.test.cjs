'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Registry}=require('../../runtime/lib/registry.cjs'),{Runtime,routes}=require('../../runtime/lib/runtime.cjs');
const {Roles}=require('../../runtime/lib/roles.cjs'),{Coordination}=require('../../runtime/lib/coordination.cjs');
const {Integrations}=require('../../runtime/lib/integrations.cjs'),lifecycle=require('../../runtime/lib/lifecycle.cjs');
const scope={tenant:'org',account:'wallet',group:'wallet',subject:'user-1',username:'Mani',permissions:['credentials.read','credentials.verify']};
function registry(){
 const rows=[],matches=(r,q)=>Object.entries(q).every(([k,v])=>r[k]===v);
 const collection={createIndex:async()=>{},find:q=>({limit:()=>({toArray:async()=>rows.filter(r=>matches(r,q))})}),findOne:async q=>rows.find(r=>matches(r,q)),insertOne:async r=>{if(rows.some(x=>matches(x,{tenant:r.tenant,account:r.account,group:r.group,id:r.id})))throw {code:11000};rows.push(structuredClone(r));},updateOne:async(q,p)=>{const r=rows.find(r=>matches(r,q));if(!r)return {matchedCount:0};Object.assign(r,structuredClone(p.$set));return {matchedCount:1};}};
 const db={collection:name=>{assert.equal(name,'credential_types');return collection;}},issued=[];
 const events={types:async()=>({source:'issuer-metadata',items:[{id:'Native',available:true,fields:{name:{required:true,maxLength:100}},format:'ldp_vc'}]}),issue:async(c,b)=>{issued.push(b);return {state:'succeeded',offer:{}};}};
 return {r:new Registry(db,events),db,events,rows,issued};
}
const definition={id:'Custom',name:'Custom type',description:'Business type',format:'ldp_vc',issuerConfigurationId:'',fields:{name:{required:true,maxLength:100}}};
test('registry CRUD persists definitions, isolates OCM scope and never writes credential storage',async()=>{
 const m=registry();await m.r.init();await m.r.change(scope,null,definition);assert.equal((await m.r.list(scope)).items.find(x=>x.id==='Custom').available,false);
 const fresh=new Registry(m.db,m.events);assert.equal((await fresh.list(scope)).items.find(x=>x.id==='Custom').name,'Custom type');
 assert.equal((await fresh.list({...scope,tenant:'different'})).items.some(x=>x.id==='Custom'),false);
 await fresh.change(scope,'Custom',{...definition,name:'Updated',format:'custom-format',issuerConfigurationId:'Native',revision:1});
 assert.equal((await fresh.list(scope)).items.find(x=>x.id==='Custom').format,'ldp_vc');
 await fresh.issue(scope,{credentialConfigurationId:'Custom',claims:{name:'Alice'}},'op');assert.equal(m.issued[0].credentialConfigurationId,'Native');
 await fresh.change(scope,'Custom',{revision:2},true);assert.equal((await fresh.list(scope)).items.some(x=>x.id==='Custom'),false);
 await fresh.change(scope,null,definition);assert.equal((await fresh.list(scope)).items.find(x=>x.id==='Custom').revision,4);
});
test('registry enforces optimistic revisions, issuer linkage, claims and native suppression',async()=>{
 const {r,issued}=registry();await r.change(scope,null,definition);
 await assert.rejects(r.change(scope,'Custom',{...definition,revision:0}),{code:'REGISTRY_CHANGED'});
 await assert.rejects(r.issue(scope,{credentialConfigurationId:'Custom',claims:{name:'Alice'}},'op'),{code:'ISSUER_TEMPLATE_UNAVAILABLE'});assert.equal(issued.length,0);
 await assert.rejects(r.change(scope,'Custom',{...definition,revision:1,issuerConfigurationId:'arbitrary.topic'}),{code:'ISSUER_TEMPLATE_UNAVAILABLE'});
 await r.change(scope,'Native',{revision:0},true);assert.equal((await r.list(scope)).items.some(x=>x.id==='Native'),false);
 await assert.rejects(r.issue(scope,{credentialConfigurationId:'Native',claims:{}},'op'),{code:'UNKNOWN_CREDENTIAL_TYPE'});
});
test('registry cannot set native dispatch subjects or change IDs',async()=>{
 const {r}=registry();await assert.rejects(r.change(scope,null,{...definition,subject:'dangerous.command'}),{code:'VALIDATION_ERROR'});
 await r.change(scope,null,definition);await assert.rejects(r.change(scope,'Custom',{...definition,id:'Other',revision:1}),{code:'TYPE_ID_IMMUTABLE'});
});
test('audit records authenticated actor identity alongside stable subject',async()=>{
 let record;const c=new Coordination({collection:name=>({insertOne:async x=>{assert.equal(name,'audit_events');record=x;}})});
 await c.audit(scope,'createType','succeeded','request');assert.deepEqual(record.actor,{subject:'user-1',username:'Mani'});assert.equal(record.subject,'user-1');assert.equal(record.token,undefined);
});
test('role permission payload reaches its handler while scope injection is rejected',async()=>{
 const run=async(path,body)=>{
  let dispatched=false,code=200,payload;
  const r={c:{publicOrigin:'https://wallet.example'},auth:{fromRequest:async()=>scope,require(){}},limit(){},ready:true,coordination:{run:async(c,a,k,b,fn)=>fn('op'),audit:async()=>{}},events:{emit(){}},counts:new Map(),execute:async()=>{dispatched=true;return {state:'succeeded'};}};
  const res={setHeader(){},status(n){code=n;return this;},json(x){payload=x;return this;}};
  await Runtime.prototype.handle.call(r,{method:'POST',url:path,headers:{},body},res);return {code,payload,dispatched};
 };
 assert.equal((await run('/roles',{name:'custom',permissions:['credentials.read']})).dispatched,true);
 assert.equal((await run('/roles',{name:'custom',permissions:[],tenant:'other'})).code,403);
 assert.equal((await run('/credential-types',{permissions:['roles.manage']})).code,403);
 for(const action of ['createType','updateType','deleteType'])assert.equal(routes.find(x=>x.action===action).permission,'credentials.issue');
});
test('user management protects service accounts and last role manager; new users require a password change',async()=>{
 const r=new Roles({realm:'wallet'},null);r.lock=fn=>fn();let write;
 r.call=async(path,method,body)=>{if(method==='POST'){write=body;return;}return {username:'alice',email:'old@example.test',enabled:true};};
 await r.user(null,{username:'alice',enabled:true,temporaryPassword:'long-test-password'});assert.deepEqual(write.requiredActions,['UPDATE_PASSWORD']);assert.equal(write.credentials[0].temporary,true);
 r.protect=async()=>{throw {code:'LAST_ROLE_MANAGER'};};await assert.rejects(r.user('id',{username:'alice',enabled:false}),{code:'LAST_ROLE_MANAGER'});
 r.call=async()=>({serviceAccountClientId:'backend'});await assert.rejects(r.user('id',{},true),{code:'SYSTEM_USER_PROTECTED'});
});
test('lifecycle checks permissions and native capabilities without mutating or claiming signature verification',async()=>{
 const d=await lifecycle.inspect({detail:async()=>({status:{state:'expired'},capabilities:{verify:true,revoke:false,delete:true,revocationReason:'STATUS_NOT_MANAGED_HERE'}})},scope,'one');
 assert.equal(d.persistence,'confirmed');assert.equal(d.options.find(x=>x.action==='verify').available,true);assert.equal(d.options.find(x=>x.action==='delete').reason,'PERMISSION_DENIED');assert.equal(d.cryptographicVerification,'not_performed');
 const blocked=await lifecycle.inspect({detail:async()=>{throw {status:502,reason:'STORAGE_REGION_MISSING'};}},scope,'one');assert.equal(blocked.state,'blocked');assert.equal(blocked.code,'STORAGE_REGION_MISSING');
});
test('successful import remains successful when its lifecycle readback is blocked',async()=>{
 const r={adapters:{importCredential:async()=>({state:'succeeded',credentialId:'new'}),detail:async()=>{throw {reason:'STORAGE_REGION_MISSING'};}}};
 const result=await Runtime.prototype.execute.call(r,'importCredential',scope,null,{}, {},'op');assert.equal(result.state,'succeeded');assert.equal(result.lifecycle.state,'blocked');
});
test('PCM test distinguishes protected endpoint reachability from authenticated account access',async()=>{
 const issuer='https://id.example/realms/pcm',calls=[];
 const i=new Integrations({c:{publicOrigin:'https://wallet.example'}},{},async(url,options)=>{calls.push({url,options});if(url.includes('.well-known'))return {issuer,code_challenge_methods_supported:['S256'],authorization_endpoint:issuer+'/auth',token_endpoint:issuer+'/token',userinfo_endpoint:issuer+'/userinfo'};throw {upstreamStatus:401,code:'UPSTREAM_REJECTED'};});
 const report=await i.test({pcm:{enabled:true,issuer,clientId:'ui',tenant:'pcm',accountUrl:'https://account.example'},trustedHosts:[]});
 assert.equal(report.state,'partial');assert.equal(report.checks.find(x=>x.name==='accountEndpoint').state,'authentication_required');assert.equal(report.checks.find(x=>x.name==='personalLogin').state,'not_tested');assert.ok(calls.every(x=>!x.options.headers?.authorization));
 const live=await Runtime.prototype.execute.call({pcm:{records:async()=>({}),offers:async()=>({}),keys:async()=>{throw {code:'DENIED'};}}},'pcmTest',{...scope,pcm:true});assert.equal(live.state,'failed');
});
