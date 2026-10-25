'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Integrations}=require('../../runtime/lib/integrations.cjs'),{routes}=require('../../runtime/lib/runtime.cjs');
const {registryProviders,Clearing}=require('../../runtime/lib/clearing.cjs');
const issuer='https://identity.pcm.example/realms/pcm';
const form={pcm:{enabled:true,issuer,clientId:'wallet',tenant:'pcm',accountUrl:'https://pcm.example',services:{storage:'https://storage.pcm.example'}},trustedHosts:['peer.example','https://issuer.example']};
function model(){let saved=null;const runtime={c:{tenant:'org',publicOrigin:'https://wallet.example'}};const db={collection:()=>({createIndex:async()=>{},findOne:async()=>saved,updateOne:async(q,p)=>{saved={settings:p.$set.settings};}})};
 const fetcher=async(url,o)=>{assert.equal(url,issuer+'/.well-known/openid-configuration');assert.equal(o.headers,undefined);return {issuer,code_challenge_methods_supported:['S256'],authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',userinfo_endpoint:issuer+'/userinfo'};};return {runtime,db,fetcher};}
test('PCM settings persist across a restart and use only configured remote service endpoints',async()=>{
 const m=model(),first=new Integrations(m.runtime,m.db,m.fetcher);await first.init();await first.save(form);assert.equal(m.runtime.pcm.http.urls.storage,'https://storage.pcm.example');assert.equal(m.runtime.pcm.http.urls.signer,undefined);assert.equal(m.runtime.c.pcm.authorizationEndpoint,issuer+'/authorize');
 const next=new Integrations(m.runtime,m.db,m.fetcher);await next.init();assert.equal(next.get().pcm.enabled,true);assert.deepEqual(next.get().trustedHosts,['peer.example','issuer.example']);assert.equal(next.get().redirectUri,'https://wallet.example/orce/pcm/callback');
 await next.save({pcm:{enabled:false},trustedHosts:[]});assert.equal(m.runtime.pcm,null);
});
test('only administrators manage connections and OIDC authority mismatch fails before saving',async()=>{
 assert.ok(routes.filter(r=>r.path.startsWith('/connections')).every(r=>r.permission==='roles.manage'));
 const m=model(),i=new Integrations(m.runtime,m.db,async()=>({issuer:'https://foreign.example'}));await assert.rejects(i.save(form),{code:'PCM_OIDC_INCOMPATIBLE'});assert.equal((await m.db.collection().findOne()),null);
 await assert.rejects(i.validate({...form,pcm:{...form.pcm,accountUrl:'http://localhost:8080'}}),{code:'CONNECTION_URL_INVALID'});
});
test('Clearing Houses come from registered v2 compliance endpoints, with production and lab kept distinct',async()=>{
 const found=registryProviders({compliance:['https://compliance.provider.example/v2','https://compliance.lab.gaia-x.eu/v2','https://old.provider.example/v1'],registry:['https://registry.provider.example/v2']});assert.equal(found.length,1);assert.equal(found[0].environment,'production');
 const calls=[],clearing=new Clearing(async(url,o)=>{calls.push({url,o});if(url.endsWith('clearing-houses'))return {compliance:['https://compliance.provider.example/v2']};return {data:{type:['VerifiableCredential'],issuer:'did:web:provider.example',credentialSubject:{id:'did:web:holder.example'}}};});
 const list=await clearing.list();const result=await clearing.acquire({provider:list.items[0].id,verifiablePresentation:'signed.vp.jwt'});assert.equal(result.environment,'production');assert.equal(calls[1].o.body.clearingHouse,'compliance.provider.example/v2');assert.equal(calls[1].o.headers,undefined);
});

test('PCM PKCE exchange is same-origin, does not forward organizational tokens, and never stores personal tokens',async()=>{
 const m=model(),i=new Integrations(m.runtime,m.db,m.fetcher);await i.init();await i.save(form);
 const before=JSON.stringify(await m.db.collection().findOne());let seen;
 i.fetch=async(url,o)=>{seen={url,o};return {access_token:'personal-token',refresh_token:'refresh-personal',token_type:'bearer',expires_in:300,id_token:'unused-id-token'};};
 const result=await i.token({grant_type:'authorization_code',code:'code',code_verifier:'a'.repeat(48)});
 assert.equal(seen.url,issuer+'/token');assert.deepEqual(seen.o.headers,{'content-type':'application/x-www-form-urlencoded'});
 const body=new URLSearchParams(seen.o.body);assert.equal(body.get('redirect_uri'),'https://wallet.example/orce/pcm/callback');assert.equal(body.get('client_id'),'wallet');
 assert.equal(result.access_token,'personal-token');assert.equal(result.id_token,undefined);assert.equal(JSON.stringify(await m.db.collection().findOne()),before);
 await i.token({grant_type:'refresh_token',refresh_token:'refresh-personal'});assert.equal(new URLSearchParams(seen.o.body).get('redirect_uri'),null);
 await assert.rejects(i.token({grant_type:'password',username:'any',password:'any'}),{code:'VALIDATION_ERROR'});
 await assert.rejects(i.token({grant_type:'authorization_code',code:'code',code_verifier:'a'.repeat(48),tokenEndpoint:'https://foreign.example'}),{code:'VALIDATION_ERROR'});
 const route=routes.find(r=>r.path==='/pcm/token');assert.equal(route.permission,'credentials.read');assert.equal(route.mutate,undefined);assert.equal(route.pcm,undefined);
});
test('saved connection forms can be loaded and saved again without leaking derived OIDC fields',async()=>{
 const m=model(),i=new Integrations(m.runtime,m.db,m.fetcher);await i.save(form);const saved=i.get();assert.equal(saved.pcm.tokenEndpoint,undefined);await i.save({pcm:saved.pcm,trustedHosts:saved.trustedHosts});assert.equal(m.runtime.c.pcm.tokenEndpoint,issuer+'/token');
});

test('personal revocation authority comes from that account’s owned DIDs, never organizational issuer settings',async()=>{
 const {PcmAdapters}=require('../../runtime/lib/pcm.cjs');
 const p=new PcmAdapters({tenant:'org',publicOrigin:'https://organization.example',issuerDids:['did:web:organization.example'],pcm:{tenant:'pcm',accountUrl:'https://personal.example',cryptoNamespace:'pcm-cloud',services:{status:'https://personal.example/api/status'}}},{call:async()=>({list:[{id:'key',did:'did:jwk:personal'}]})});
 const scoped=await p.statusConfiguration({token:'personal'});assert.equal(scoped.publicOrigin,'https://personal.example');assert.deepEqual(scoped.issuerDids,['did:jwk:personal']);
 p.keys=async()=>{throw Error('remote failure');};assert.deepEqual((await p.statusConfiguration({})).issuerDids,[]);
});
