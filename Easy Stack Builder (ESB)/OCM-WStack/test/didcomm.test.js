'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),ocm=require('../lib/ocm');
const c={tenantUrl:'https://demo-tenant.example.com',tenantId:'demo-tenant',tenantRelease:'demotenant',tenantHost:'demo-tenant.example.com',runtimeEnabled:true,runtimeServices:{}};
test('main-tracking ApplicationSet enables the native connector and preserves unrelated exclusions',()=>{
 const upstream=['OCM W-Stack/tenant','OCM W-Stack/Policies',ocm.DIDCOMM,'OCM W-Stack/Tools','OCM W-Stack/Future'];
 const result=ocm.applicationExcludes(c,upstream);assert.deepEqual(result,upstream.filter(x=>x!==ocm.DIDCOMM));assert.equal(upstream.length,5);const v=ocm.values({...c,ocmExcludes:result});assert.equal(v.tag,'main');assert.deepEqual(v.excludes,result);assert.match(v.esbTemplatePatch,/OCM W-Stack\/Didcomm/);
 assert.deepEqual(ocm.applicationExcludes({...c,runtimeEnabled:false},upstream),upstream);assert.deepEqual(ocm.applicationExcludes({...c,runtimeServices:{didcomm:'https://existing.example'}},upstream),upstream);
});
test('native DIDComm uses existing infrastructure and persistent Cassandra with managed credentials',()=>{
 const d=ocm.overrides(c)[ocm.DIDCOMM]['didcomm-connector'];assert.equal(d.config.database.inMemory,false);assert.equal(d.config.database.host,'cassandra.infrastructure.svc.cluster.local');assert.equal(d.config.database.password.passwordSecret,ocm.CASSANDRA_SECRET);assert.equal(d.config.url,c.tenantUrl+'/api/didcomm');assert.equal(d.ingress.enabled,false);assert.equal(d.podAnnotations['inject.xfsc.io/enabled'],'false');
});
test('native DIDComm render contract refuses placeholder infrastructure and wrong secret references',()=>{
 const env=Object.entries({DIDCOMMCONNECTOR_DATBASE_HOST:'cassandra.infrastructure.svc.cluster.local',DIDCOMMCONNECTOR_DATBASE_PORT:'9042',DIDCOMMCONNECTOR_DIDCOMM_RESOLVERURL:'http://universal-resolver.infrastructure.svc.cluster.local:8080',DIDCOMMCONNECTOR_CLOUDFORWARDING_NATS_URL:'nats://nats.infrastructure.svc.cluster.local:4222',DIDCOMMCONNECTOR_URL:c.tenantUrl+'/api/didcomm'}).map(([name,value])=>({name,value}));
 env.push({name:'DIDCOMMCONNECTOR_DATBASE_PASSWORD',valueFrom:{secretKeyRef:{name:ocm.CASSANDRA_SECRET,key:'cassandra-password'}}});
 const documents={deployment:{kind:'Deployment',spec:{template:{spec:{containers:[{name:'didcomm-connector',env}]}}}}};ocm.validateManifests(documents,ocm.DIDCOMM);env[0].value='cassandra.NAMESPACE';assert.throws(()=>ocm.validateManifests(documents,ocm.DIDCOMM),{code:'OCM_VALUES'});
 env[0].value='cassandra.infrastructure.svc.cluster.local';env.at(-1).valueFrom.secretKeyRef.name='wrong';assert.throws(()=>ocm.validateManifests(documents,ocm.DIDCOMM),{code:'OCM_VALUES'});
});
test('DIDComm routing exposes only native message delivery; all other native routes survive',()=>{
 const defaults={routes:[{name:'credential-issuance',path:'/api/credential'},{name:'didcomm',path:'/api/didcomm',targetPath:'/',backend:{name:'didcomm-connector',port:9090}}]};
 const v=require('../lib/tenant-values').values(c,defaults);assert.deepEqual(v.routes[0],defaults.routes[0]);assert.equal(v.routes[1].enabled,false);assert.deepEqual(v.routes[2],{name:'didcomm-message',method:'POST',path:'/api/didcomm/message/receive',pathType:'Exact',targetPath:'/message/receive',backend:{name:'didcomm-connector',port:9090}});assert.equal(defaults.routes[1].enabled,undefined);
 assert.equal(require('../lib/tenant-values').values({...c,runtimeEnabled:false},defaults).routes.length,2);
});
test('readiness includes the actual DIDComm list contract; outage cannot report nativeReady',async()=>{
 const {Runtime}=require('../runtime/lib/runtime.cjs');const app=new Runtime({...c,services:{}});app.adapters.records=async()=>({});app.adapters.offers=async()=>({});app.issuerBootstrap.ensure=async()=>{};app.events.connected=true;app.adapters.relationships=async()=>{throw Object.assign(Error(),{code:'UPSTREAM_UNAVAILABLE'});};await app.probeNative();assert.equal(app.nativeState.ready,false);assert.equal(app.nativeState.checks.find(x=>x.name==='didcomm').ok,false);app.adapters.relationships=async()=>({items:[]});await app.probeNative();assert.equal(app.nativeState.ready,true);
});
