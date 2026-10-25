'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeOffer,offerUrl}=require('../../runtime/lib/offers.cjs');
const {Adapters}=require('../../runtime/lib/adapters.cjs');
const {Coordination}=require('../../runtime/lib/coordination.cjs');
const {summarize}=require('../../scripts/service-image-status.cjs');
const inner={credential_issuer:'https://issuer.example',credential_configuration_ids:['Demo'],grants:{'urn:ietf:params:oauth:grant-type:pre-authorized_code':{'pre-authorized_code':'test +%&=é'}}};
const link='openid-credential-offer://?'+new URLSearchParams({credential_offer:JSON.stringify(inner)});
const native={credential_offer:link};
test('native complete link is encoded once and import sends the complete link expected by Go',async()=>{
 assert.equal(offerUrl(native),link);
 const a=new Adapters({offerIssuerHosts:['issuer.example']},{call:async(n,p,o)=>{assert.equal(n,'retrieval');assert.equal(p,'/v1/tenants/tenant_space/offering/retrieve/team');assert.deepEqual(o.body,{credential_offer:link});return 'retrieval-id';}});
 assert.equal((await a.importOffer({tenant:'tenant_space',group:'team'},offerUrl(native))).upstreamRequestId,'retrieval-id');
});
test('previous double-wrapped links and encrypted completed jobs recover without dispatch',()=>{
 const old='openid-credential-offer://?'+new URLSearchParams(native);
 assert.equal(offerUrl(old),link);
 const c=new Coordination(null,'ab'.repeat(32));const job=c.publicJob({state:'succeeded',encryptedOffer:c.seal(native)});
 assert.equal(offerUrl(job.offer),link);
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
test('image report identifies official release images and excludes secret environment values',()=>{
 const image='node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/ocm-wstack/storage-service:1.2.4';
 const c={name:'storage-service',image,env:[{name:'STORAGESERVICE_REGION',value:'EU'},{name:'PASSWORD',value:'never-print'}]};
 const r=summarize({items:[{metadata:{name:'storage-service'},spec:{template:{spec:{containers:[c]}}}}]},{items:[{metadata:{name:'storage-1'},spec:{containers:[c],nodeName:'worker'},status:{containerStatuses:[{name:c.name,imageID:'sha256:test',ready:true}]}}]});
 assert.equal(r[0].officialImageSelected,true);assert.equal(r[0].pods[0].imageID,'sha256:test');assert.equal(r[1].officialImageSelected,false);assert.ok(!JSON.stringify(r).includes('never-print'));
});
