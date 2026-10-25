'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {credentialsPath}=require('../runtime/lib/storage-path.cjs');
const {discover}=require('../lib/storage-scope');
const {Adapters}=require('../runtime/lib/adapters.cjs');
test('Storage 1.2.5 scopes list, import, deletion and chain requests to configured geography',async()=>{
 const calls=[],a=new Adapters({storageRegion:'EU',storageCountry:'NL'},{call:async(n,p,o)=>{calls.push({n,p,o});return {credentials:{}};}}),ctx={tenant:'demo-tenant',account:'ocm-wstack',group:'ocm-wstack'};
 await a.records(ctx);await a.remove(ctx,'record-1');
 assert.equal(calls[0].p,'/v1/tenants/demo-tenant/storage/EU/NL/ocm-wstack/credentials');assert.equal(calls[0].o.method,'POST');assert.deepEqual(calls[0].o.body,{});
 assert.equal(calls[1].p,calls[0].p+'/record-1');assert.equal(calls[1].o.method,'DELETE');
 assert.equal(credentialsPath({tenant:'demo-tenant',account:'ocm-wstack'}),'/v1/tenants/demo-tenant/storage/EU/DE/ocm-wstack/credentials');
 assert.throws(()=>credentialsPath({tenant:'demo-tenant',account:'..'}));
});
test('OCM geography follows installed Retrieval configuration without another editor field',async()=>{
 const c={},r={emit(){},json:async()=>({spec:{template:{spec:{containers:[{name:'credential-retrieval-service',env:[{name:'CREDENTIALRETRIEVAL_REGION',value:'EU'},{name:'CREDENTIALRETRIEVAL_COUNTRY',value:'NL'}]}]}}}})};
 await discover(r,c);assert.deepEqual(c,{storageRegion:'EU',storageCountry:'NL'});
 const conf=require('../lib/runtime-install').runtimeConfig({...c,tenantId:'demo-tenant',tenantUrl:'https://demo-tenant.example.com',tenantHost:'demo-tenant.example.com',pcm:{enabled:false},runtimeServices:{}});assert.equal(conf.storageCountry,'NL');
});
