'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {config,resolve,fingerprint}=require('../lib/config'),legacy=require('../lib/legacy-config'),{ensureMarker}=require('../lib/install');
const lock=require('../upstream-lock.json');
const input={procedureVersion:12,domain:'example.com',email:'m@example.com'},nodes={items:[]},classes={items:[{metadata:{name:'ionos-cloud-essential',annotations:{'storageclass.kubernetes.io/is-default-class':'true'}},provisioner:'ionos'}]};
function resolved(){const c={...resolve(config(input),nodes,classes,{}),clusterUid:'cluster-uid'};c.legacyFingerprint=legacy.fingerprint({...legacy.resolve(legacy.config(input),nodes,classes,{}),clusterUid:c.clusterUid});return c;}
test('matching 12.0.9 ownership migrates when the only upstream changes are reviewed additions',async()=>{const c=resolved(),marker={metadata:{name:'esb-ocmwstack-v12'},data:{instance:c.instanceName,clusterUid:c.clusterUid,fingerprint:c.legacyFingerprint,upstreamCommit:lock.compatibleBootstrapCommits[0]}};let writes=0;const r={json:async(cmd,args,opt)=>{if(args.includes('replace')){writes++;return JSON.parse(opt.input);}return structuredClone(marker);}};const out=await ensureMarker(r,c);assert.equal(writes,1);assert.equal(out.data.upstreamCommit,lock.commit);assert.equal(out.data.fingerprint,fingerprint(c));});
test('changed tenant or cluster cannot be adopted through release migration',async()=>{const c=resolved();const r={json:async()=>({data:{instance:c.instanceName,clusterUid:'another-cluster',fingerprint:c.legacyFingerprint,upstreamCommit:lock.compatibleBootstrapCommits[0]}})};await assert.rejects(ensureMarker(r,c),{code:'OWNERSHIP'});});
test('UI additions do not change ownership of the same native stack',()=>{const c=resolved();assert.equal(fingerprint(c),fingerprint({...c,runtimeEnabled:false,uiAdminUsername:'operator',runtimeImage:'ecofacis/xfsc-orce:2.0.15'}));assert.notEqual(fingerprint(c),fingerprint({...c,tenantId:'foreign'}));});

test('owned installations can change DNS and dashboard toggles but cannot adopt a different tenant or storage class',()=>{
 const {matches}=require('../lib/install'),c=resolved();const marker={metadata:{labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}},data:{instance:c.instanceName,clusterUid:c.clusterUid,fingerprint:'legacy',tenantId:c.tenantId,tenantRelease:c.tenantRelease,tenantHost:c.tenantHost,storageClass:c.actualStorageClass}};
 assert.equal(matches(marker,{...c,externalDns:true,publicDashboards:true}),true);assert.equal(matches(marker,{...c,tenantId:'other'}),false);assert.equal(matches(marker,{...c,actualStorageClass:'other'}),false);assert.equal(matches({...marker,metadata:{}},c),false);
});
