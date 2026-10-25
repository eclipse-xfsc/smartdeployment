'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeOffer,offerUrl}=require('../../runtime/lib/offers.cjs');
const {Adapters}=require('../../runtime/lib/adapters.cjs');
const {Coordination}=require('../../runtime/lib/coordination.cjs');
const inner={credential_issuer:'https://issuer.example',credential_configuration_ids:['Demo'],grants:{'urn:ietf:params:oauth:grant-type:pre-authorized_code':{'pre-authorized_code':'test +%&=é'}}};
const link='openid-credential-offer://?'+new URLSearchParams({credential_offer:JSON.stringify(inner)});
const native={credential_offer:link};
test('native complete link is encoded once and import sends the complete link expected by Go',async()=>{
 assert.equal(offerUrl(native),link);
 const a=new Adapters({offerIssuerHosts:['issuer.example']},{call:async(n,p,o)=>{assert.equal(n,'retrieval');assert.equal(p,'/v1/tenants/tenant_space/offering/retrieve/team');assert.deepEqual(o.body,{credential_offer:link});return 'retrieval-id';}});
 assert.equal((await a.importOffer({tenant:'tenant_space',group:'team'},offerUrl(native))).upstreamRequestId,'retrieval-id');
});
test('previous double-wrapped links normalize without rewriting issuer parameters',()=>{
 const old='openid-credential-offer://?'+new URLSearchParams(native);
 assert.equal(offerUrl(old),link);
});
test('normalization rejects ambiguous fields, duplicate query keys, nesting abuse and unsupported protocols',()=>{
 for(const bad of [link+'&credential_offer=x',link+'&credential_offer_uri=https://issuer.example/x',{...native,credential_offer_uri:'https://issuer.example/x'},'openid-credential-offer://evil/?credential_offer=x','https://issuer.example/x',null])assert.throws(()=>normalizeOffer(bad));
 let deep=native;for(let i=0;i<12;i++)deep={credential_offer:deep};assert.throws(()=>normalizeOffer(deep),{code:'VALIDATION_ERROR'});
});
test('unwrapping never bypasses issuer approval',async()=>{
 const a=new Adapters({offerIssuerHosts:['allowed.example']},{call:()=>assert.fail('must not dispatch')});
 await assert.rejects(a.importOffer({},'openid-credential-offer://?'+new URLSearchParams(native)),{code:'OFFER_ISSUER_NOT_ALLOWED'});
});
test('reference links normalize once and reject unsafe reference URLs',()=>{
 const ref='https://issuer.example/offer?id=one%2Btwo';
 const uri='openid-credential-offer://?'+new URLSearchParams({credential_offer_uri:ref});
 assert.equal(offerUrl({credential_offer_uri:uri}),uri);
 assert.throws(()=>offerUrl({credential_offer_uri:'http://issuer.example/offer'}),{code:'OFFER_ISSUER_NOT_ALLOWED'});
});
