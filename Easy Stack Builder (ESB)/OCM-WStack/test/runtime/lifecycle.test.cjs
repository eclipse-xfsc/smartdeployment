'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Adapters}=require('../../runtime/lib/adapters.cjs');
const {PcmAdapters,PcmIdentity}=require('../../runtime/lib/pcm.cjs');
const {graph}=require('../../runtime/lib/provenance.cjs');
const {hintFromEvent}=require('../../runtime/lib/events.cjs');
const {Clearing}=require('../../runtime/lib/clearing.cjs');
const {routes}=require('../../runtime/lib/runtime.cjs');
const config={publicOrigin:'https://wallet.example',tenant:'tenant_space',account:'org',group:'org',cryptoNamespace:'ocm-wstack',cryptoGroup:'',holderKey:'eckey',issuerDids:['did:web:wallet.example'],offerIssuerHosts:['issuer.example'],pcm:{enabled:true,tenant:'tenant_space',namespace:'pcm',cryptoNamespace:'accountSpace',services:{storage:'https://pcm.example',retrieval:'https://pcm.example',signer:'https://pcm.example',status:'https://pcm.example'},userInfo:'https://id.example/realms/master/protocol/openid-connect/userinfo'}};
const org={subject:'operator',tenant:'tenant_space',account:'org',group:'org',permissions:['credentials.read','credentials.delete'],token:'org-token'};
const vc={type:['VerifiableCredential','Participant'],issuer:'did:web:issuer.example',credentialSubject:{id:'did:web:holder.example'},issuanceDate:'2026-09-01T00:00:00Z'};
const wrapped={groups:[{credentials:{one:{type:'ldp_vc',data:JSON.stringify(vc)}}}]};

test('Storage list requests no descriptors and unwraps native credential results',async()=>{
 const a=new Adapters(config,{call:async(n,p,o)=>{assert.equal(n,'storage');assert.deepEqual(o.body,{});return wrapped;}});
 const list=await a.list(org);assert.equal(list.items[0].issuer.id,vc.issuer);assert.equal(list.items[0].types[1],'Participant');
 assert.equal((await a.detail(org,'one')).raw,JSON.stringify(vc));
});
test('Storage parser rejects malformed groups and conflicting duplicate IDs',()=>{
 const a=new Adapters(config,{});assert.throws(()=>a.unpack({groups:{}}),{code:'UPSTREAM_PROTOCOL_ERROR'});
 assert.throws(()=>a.unpack({credentials:{a:'one'},groups:[{credentials:{a:'two'}}]}),{code:'UPSTREAM_PROTOCOL_ERROR'});
});
test('list sorts, filters and paginates without reporting unverified credentials as active',async()=>{
 const a=new Adapters(config,{call:async()=>({credentials:{a:vc,b:{...vc,expirationDate:'2020-01-01T00:00:00Z'}}})});
 const all=await a.list(org,{pageSize:1,sort:'id',direction:'desc'});assert.equal(all.items[0].id,'b');assert.equal(all.counts.expired,1);assert.equal(all.counts.notChecked,1);
 const next=await a.list(org,{pageSize:1,sort:'id',direction:'desc',cursor:all.nextCursor});assert.equal(next.items[0].id,'a');
 const expired=await a.list(org,{status:'expired'});assert.equal(expired.total,1);assert.equal(expired.items[0].status.state,'expired');
});
test('native import uses the coordinated operation ID and exact credential',async()=>{
 const a=new Adapters(config,{call:async(n,p,o)=>{assert.equal(p,'/v1/tenants/tenant_space/storage/EU/DE/org/credentials/op-1');assert.equal(o.method,'PUT');assert.deepEqual(o.body,vc);}});
 assert.equal((await a.importCredential(org,{credential:vc},'op-1')).credentialId,'op-1');
});
test('list checks managed revocation once per list and filters revoked credentials',async()=>{
 let reads=0;const entry=i=>({...vc,issuer:config.issuerDids[0],credentialStatus:{type:'StatusList2021Entry',statusPurpose:'revocation',statusListCredential:config.publicOrigin+'/api/status/1',statusListIndex:String(i)}});
 const a=new Adapters(config,{call:async(n)=>{if(n==='storage')return {credentials:{a:entry(0),b:entry(1),c:vc}};reads++;return {tenantId:org.tenant,listId:1,list:require('node:zlib').gzipSync(Buffer.from([128])).toString('base64url')};}});
 const r=await a.list(org,{status:'revoked'});assert.equal(reads,1);assert.equal(r.total,1);assert.equal(r.items[0].id,'a');assert.equal(r.counts.active,1);assert.equal(r.counts.revoked,1);assert.equal(r.counts.notChecked,1);
});
test('SD-JWT verification supplies the mandatory frame and returns verified disclosures',async()=>{
 const raw='e30.'+Buffer.from(JSON.stringify({iss:'did:web:issuer.example',vct:'Participant'})).toString('base64url')+'.sig~';
 const a=new Adapters(config,{call:async(n,p,o)=>{
  if(n==='storage')return {credentials:{one:raw}};
  assert.equal(n,'signer');assert.equal(o.headers['x-format'],'dc+sd-jwt');assert.deepEqual(o.body.disclosureFrame,[]);assert.equal(Buffer.from(o.body.credential,'base64').toString(),raw);
  return {valid:true,disclosedCredential:{name:'Alice'}};
 }});
 const result=await a.verify(org,'one');assert.equal(result.cryptographic.state,'valid');assert.deepEqual(result.disclosedClaims,{name:'Alice'});
});
test('PCM scope derives from trusted userinfo and never from organizational account',async()=>{
 const i=new PcmIdentity(config,async(url,o)=>{assert.equal(url,config.pcm.userInfo);assert.equal(o.headers.authorization,'Bearer personal-token');return {sub:'alice'};});
 const c=await i.context(org,'Bearer personal-token');assert.equal(c.account,'alice');assert.equal(c.group,'alice');assert.equal(c.subject,'operator');assert.equal(c.token,'personal-token');
 await assert.rejects(i.context(org,null),{code:'PCM_AUTHENTICATION_REQUIRED'});
});
test('PCM identity fails closed on expired or rejected tokens',async()=>{
 const i=new PcmIdentity(config,async()=>{throw Error('expired');});await assert.rejects(i.context(org,'Bearer expired'),{code:'PCM_AUTHENTICATION_REQUIRED'});
});
test('PCM list consumes Account Service groups; deletion uses native Storage only after ownership check',async()=>{
 const calls=[],c={...org,account:'alice',group:'alice',token:'pcm-token'},a=new PcmAdapters(config,{call:async(n,p,o)=>{calls.push({n,p,o});return n==='pcm'?wrapped.groups:null;}});
 const result=await a.remove(c,'one');assert.equal(result.state,'succeeded');assert.equal(calls[0].n,'pcm');assert.equal(calls[0].o.headers.authorization,'Bearer pcm-token');assert.equal(calls[1].p,'/v1/tenants/tenant_space/storage/alice/credentials/one');assert.equal(calls[1].n,'storage');
 await assert.rejects(a.remove(c,'foreign'),{code:'RESOURCE_NOT_FOUND'});assert.equal(calls.filter(x=>x.o.method==='DELETE').length,1);
});
test('PCM acceptance validates selected key ownership and uses accountSpace crypto namespace',async()=>{
 const c={...org,account:'alice',group:'alice'},a=new PcmAdapters(config,{call:async(n,p,o)=>{
  if(n==='pcm')return {list:[{id:'key-a',did:'did:jwk:a'}]};
  assert.equal(p,'/v1/tenants/tenant_space/offering/clear/alice/req-1');assert.equal(o.body.holderNamespace,'accountSpace');assert.equal(o.body.holderGroup,'alice');assert.equal(o.body.tx_code,'123');return null;
 }});
 await a.accept(c,'req-1',true,{holderKey:'key-a',txCode:'123'});
 await assert.rejects(a.accept(c,'req-1',true,{holderKey:'foreign'}),{code:'PCM_HOLDER_KEY_REQUIRED'});
});
test('all personal lifecycle routes carry PCM identity scope and matching permissions',()=>{
 for(const action of ['credentials','credential','deleteCredential','verify','revoke','importCredential','provenance','offers','import','accept','reject','types','issue','job']){
  const r=routes.find(x=>x.pcm&&x.action===action);assert.ok(r,action);assert.ok(r.path.startsWith('/pcm/'));assert.ok(r.permission);
 }
});
test('provenance follows multiple issuer-holder hops and never claims verification',()=>{
 const g=graph({one:vc,two:{...vc,issuer:vc.credentialSubject.id,credentialSubject:{id:'did:web:next.example'}}},'one');assert.equal(g.nodes.filter(x=>x.kind==='credential').length,2);assert.equal(g.verified,false);assert.ok(g.edges.every(x=>x.verified===false));assert.ok(g.nodes.some(x=>x.url==='https://issuer.example/.well-known/did.json'));
});
test('native Retrieval observer emits only metadata hints for the configured scope',()=>{
 const entry={eventType:'retrieval.offering.received',type:'offers.changed'},event={specversion:'1.0',type:entry.eventType,data:{tenant_id:'tenant_space',group_id:'org',secret:'must-not-leak'}};
 const hint=hintFromEvent(Buffer.from(JSON.stringify(event)),entry,config);assert.deepEqual(hint,{type:'offers.changed',requiresRefresh:true});
 event.data.group_id='foreign';assert.equal(hintFromEvent(Buffer.from(JSON.stringify(event)),entry,config),null);
});
test('Clearing request sends only the supplied presentation and labels test results',async()=>{
 const c=new Clearing(async(url,o)=>{assert.equal(url,'https://wizard.lab.gaia-x.eu/api/credential-offers');assert.deepEqual(o.body,{verifiablePresentation:'signed.vp.jwt'});assert.equal(o.headers,undefined);return {data:vc};});
 const result=await c.acquire({provider:'gaia-lab',verifiablePresentation:'signed.vp.jwt'});assert.equal(result.stored,false);assert.equal(result.environment,'test');
 await assert.rejects(c.acquire({provider:'unknown',verifiablePresentation:'vp'}),{code:'CLEARING_PROVIDER_UNAVAILABLE'});
});
