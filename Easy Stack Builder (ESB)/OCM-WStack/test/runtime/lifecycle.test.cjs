'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Adapters}=require('../../runtime/lib/adapters.cjs');
const {graph}=require('../../runtime/lib/provenance.cjs');
const {hintFromEvent}=require('../../runtime/lib/events.cjs');
const {Clearing}=require('../../runtime/lib/clearing.cjs');
const {routes}=require('../../runtime/lib/runtime.cjs');
const config={publicOrigin:'https://ocm.example',tenant:'tenant_space',account:'org',group:'org',cryptoNamespace:'ocm-wstack',cryptoGroup:'',holderKey:'eckey',issuerDids:['did:web:ocm.example'],offerIssuerHosts:['issuer.example'],pcm:{enabled:true,tenant:'tenant_space',namespace:'pcm',cryptoNamespace:'accountSpace',services:{storage:'https://pcm.example',retrieval:'https://pcm.example',signer:'https://pcm.example',status:'https://pcm.example'},userInfo:'https://id.example/realms/master/protocol/openid-connect/userinfo'}};
const org={subject:'operator',tenant:'tenant_space',account:'org',group:'org',permissions:['credentials.read','credentials.delete'],token:'org-token'};
const vc={type:['VerifiableCredential','Participant'],issuer:'did:web:issuer.example',credentialSubject:{id:'did:web:holder.example'},issuanceDate:'2026-09-01T00:00:00Z'};
const wrapped={groups:[{credentials:{one:{type:'ldp_vc',data:JSON.stringify(vc)}}}]};

test('Storage list requests no descriptors and unwraps native credential results',async()=>{
 const a=new Adapters(config,{call:async(n,p,o)=>{assert.equal(n,'storage');assert.equal(o.body,undefined);assert.equal(o.headers['content-type'],'application/json');return wrapped;}});
 const list=await a.list(org);assert.equal(list.items[0].issuer.id,vc.issuer);assert.equal(list.items[0].types[1],'Participant');
 assert.equal((await a.detail(org,'one')).raw,JSON.stringify(vc));
});
test('Storage parser rejects malformed groups and conflicting duplicate IDs',()=>{
 const a=new Adapters(config,{});assert.throws(()=>a.unpack({groups:{}}),{code:'UPSTREAM_PROTOCOL_ERROR'});
 assert.throws(()=>a.unpack({credentials:{a:'one'},groups:[{credentials:{a:'two'}}]}),{code:'UPSTREAM_PROTOCOL_ERROR'});
});
test('list sorts, filters and paginates without reporting unverified credentials as active',async()=>{
 const a=new Adapters(config,{call:async()=>({credentials:{a:vc,b:{...vc,issuanceDate:'2019-01-01T00:00:00Z',expirationDate:'2020-01-01T00:00:00Z'}}})});
 const all=await a.list(org,{pageSize:1,sort:'id',direction:'desc'});assert.equal(all.items[0].id,'b');assert.equal(all.counts.expired,1);assert.equal(all.counts.notChecked,1);
 const next=await a.list(org,{pageSize:1,sort:'id',direction:'desc',cursor:all.nextCursor});assert.equal(next.items[0].id,'a');
 const expired=await a.list(org,{status:'expired'});assert.equal(expired.total,1);
});
test('native import uses the coordinated operation ID and exact credential',async()=>{
 const a=new Adapters(config,{call:async(n,p,o)=>{assert.equal(p,'/v1/tenants/tenant_space/storage/EU/DE/org/credentials/op-1');assert.equal(o.method,'PUT');assert.deepEqual(o.body,vc);}});
 assert.equal((await a.importCredential(org,{credential:vc},'op-1')).credentialId,'op-1');
});
test('list displays native status decisions without a local list decoder',async()=>{
 let reads=0;const entry=i=>({...vc,issuer:config.issuerDids[0],credentialStatus:{type:'StatusList2021Entry',statusPurpose:'revocation',statusListCredential:config.publicOrigin+'/api/status/1',statusListIndex:String(i)}});
 const a=new Adapters(config,{call:async(n)=>{assert.equal(n,'storage');return {credentials:{a:entry(0),b:entry(1),c:vc}};}});
 a.statusTransport={checkStatus:async(c,ref)=>{reads++;return {revocated:ref.index===0,suspended:false};}};
 const r=await a.list(org,{status:'revoked'});assert.equal(reads,2);assert.equal(r.total,1);assert.equal(r.items[0].id,'a');assert.equal(r.counts.active,1);assert.equal(r.counts.revoked,1);assert.equal(r.counts.notChecked,1);
});
test('SD-JWT verification supplies the mandatory frame and returns verified disclosures',async()=>{
 const raw='e30.'+Buffer.from(JSON.stringify({iss:'did:web:issuer.example',vct:'Participant'})).toString('base64url')+'.sig~';
 const a=new Adapters(config,{call:async(n,p,o)=>{
  if(n==='storage')return {credentials:{one:raw}};
  assert.equal(n,'signer');assert.equal(o.headers['x-format'],'dc+sd-jwt');assert.deepEqual(o.body.disclosureFrame,[]);assert.equal(Buffer.from(o.body.credential,'base64').toString(),raw);
  return {valid:true,disclosedCredential:{name:'Alice'}};
 }});
 const result=await a.verify(org,'one');assert.equal(result.cryptographic.state,'not_separately_reported');assert.equal(result.overall,'valid');assert.deepEqual(result.disclosedClaims,{name:'Alice'});
});
test('provenance follows explicit supporting credential references and never claims verification',()=>{
 const g=graph({one:{...vc,evidence:[{id:'two'}]},two:{...vc,issuer:vc.credentialSubject.id,credentialSubject:{id:'did:web:next.example'}}},'one');assert.equal(g.nodes.filter(x=>x.kind==='credential').length,2);assert.equal(g.verified,false);assert.ok(g.edges.every(x=>x.verified===false));assert.ok(g.nodes.some(x=>x.url==='https://issuer.example/.well-known/did.json'));
});
test('native Retrieval observer emits only metadata hints for the configured scope',()=>{
 const entry={eventType:'retrieval.offering.received',type:'offers.changed'},event={specversion:'1.0',type:entry.eventType,data:{tenant_id:'tenant_space',group_id:'org',secret:'must-not-leak'}};
 const hint=hintFromEvent(Buffer.from(JSON.stringify(event)),entry,config);assert.deepEqual(hint,{type:'offers.changed',requiresRefresh:true});
 event.data.group_id='foreign';assert.equal(hintFromEvent(Buffer.from(JSON.stringify(event)),entry,config),null);
});
test('planned Clearing request is blocked until its trigger/poll/result contract is verified',async()=>{
 const clearing=new Clearing();const catalog=await clearing.list();assert.equal(catalog.items[0].url,'https://clearing.gaia-x.eu/api/v1');assert.equal(catalog.items[0].requestSupported,false);
 await assert.rejects(clearing.acquire({provider:'gaia-x'}),{code:'CLEARING_CONTRACT_UNVERIFIED'});
});
