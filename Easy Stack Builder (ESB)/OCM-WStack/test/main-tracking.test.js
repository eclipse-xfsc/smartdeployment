'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {adapt,networkValues}=require('../lib/adapt'),ocm=require('../lib/ocm');
test('fresh bootstrap and all Git ApplicationSet overrides select main; upgrade waits for main comparison',async t=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'esb-main-test-'));t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
 await fs.cp(path.join(__dirname,'fixtures/upstream'),tmp,{recursive:true});await adapt(tmp);
 const fresh=(await Promise.all(['basic-cluster-init.sh','ocm-wstack-init.sh'].map(p=>fs.readFile(path.join(tmp,p),'utf8')))).join('\n');
 assert.equal((fresh.match(/--set-string tag=main/g)||[]).length,4);
 const c={actualProvider:'generic',lbAnnotations:{},externalDns:false,tenantUrl:'https://demo-tenant.example.com',tenantId:'demo-tenant'};
 assert.equal(networkValues(c).tag,'main');assert.equal(ocm.routingValues().tag,'main');assert.equal(ocm.values(c).tag,'main');
 const wait=await fs.readFile(path.join(tmp,'check-applicationset.sh'),'utf8');
 assert.match(wait,/status.sync.comparedTo.source.targetRevision/);assert.match(wait,/spec.source.targetRevision.*!= "main"/);
});
test('12.3.0 matching installation upgrades ownership in place',async()=>{
 const {config,resolve,fingerprint}=require('../lib/config'),{ensureMarker}=require('../lib/install');
 const c={...resolve(config({procedureVersion:12,domain:'example.com'}),{items:[]},{items:[{metadata:{name:'standard',annotations:{'storageclass.kubernetes.io/is-default-class':'true'}}}]},{}),clusterUid:'cluster'};
 const marker={metadata:{labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}},data:{instance:c.instanceName,clusterUid:c.clusterUid,tenantId:c.tenantId,tenantRelease:c.tenantRelease,tenantHost:c.tenantHost,storageClass:c.actualStorageClass,upstreamCommit:'8485621574abdee08b8ca24c2f0f60136ba0dad7',fingerprint:fingerprint(c),bootstrapComplete:'true'}};
 const r={json:async(cmd,args,options)=>args.includes('replace')?JSON.parse(options.input):marker};
 const updated=await ensureMarker(r,c);assert.equal(updated.data.bootstrapComplete,'true');assert.equal(updated.data.packageVersion,'12.3.3');assert.equal(updated.data.upstreamCommit,require('../upstream-lock.json').commit);
});
