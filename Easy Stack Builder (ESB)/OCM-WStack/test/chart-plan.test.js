'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {plan}=require('../lib/chart-check');
const snapshot=path.join(__dirname,'fixtures/deployment-20261009');
const parsed=require('./fixtures/deployment-20261009-sets.json');
async function fixture(t,change=()=>{}) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'esb-chart-plan-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const source=path.join(directory,'bootstrap'),argoSource=path.join(directory,'main');
 await fs.cp(snapshot,source,{recursive:true});await fs.cp(snapshot,argoSource,{recursive:true});
 const sets=structuredClone(parsed);change(sets);const events=[];
 const runner={emit:e=>events.push(e),run:async(cmd,args)=>{
  assert.equal(cmd,'helm');assert.deepEqual(args.slice(0,2),['template','esb-yaml-reader']);
  const input=JSON.parse(await fs.readFile(args.at(-1),'utf8'));assert.deepEqual(Object.keys(input.documents),Object.keys(sets));
  // Helm YAML parsing is a command double; parsed fixture comes from the exact
  // independently retrieved source bytes, whose Git blob IDs are checked below.
  assert.match(input.documents['ocm-wstack'],/^tag: oid4vp\n/);
  return {stdout:JSON.stringify(sets)};
 }};
 const c={actualStorageClass:'standard',actualProvider:'generic',lbAnnotations:{},externalDns:false,tenantId:'demo',tenantHost:'demo.example.com',tenantUrl:'https://demo.example.com',tenantRelease:'demo',runtimeEnabled:true,pcm:{enabled:false},runtimeServices:{}};
 return {directory,source,argoSource,runner,c,events};
}
test('retrieved main snapshot has independently verified Git blob identities',async()=>{
 const manifest=require('./fixtures/deployment-20261009.json');assert.equal(manifest.commit,require('../upstream-lock.json').commit);
 for(const [file,sha] of Object.entries(manifest.gitBlobs)){
  const bytes=await fs.readFile(path.join(snapshot,file));assert.equal(crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),sha,file);
 }
});
test('oid4vp source default plans current main children and installs the same definitions',async t=>{
 const f=await fixture(t);const filename='XFSC/Applicationsets/values/06_ocm_wstack-values.yaml';
 await fs.writeFile(path.join(f.source,filename),'old bootstrap defaults');
 const jobs=await plan(f.runner,f.source,f.argoSource,f.c,f.directory);
 const appset=jobs.find(j=>j.release==='ocm-wstack');assert.equal(appset.values.tag,'main');
 assert.equal(await fs.readFile(path.join(f.source,filename),'utf8'),await fs.readFile(path.join(f.argoSource,filename),'utf8'));
 for(const name of ['storage','network','core','ocm-wstack'])assert.equal(jobs.find(j=>j.release===name).values.tag,'main');
 const children=jobs.filter(j=>j.applicationSet==='ocm-wstack');assert.equal(children.length,13);
 assert.ok(children.every(j=>j.root===f.argoSource));
 for(const chart of ['Credential Retrieval','Crypto Service','SdJwt Service','Storage Service','Didcomm'])assert.ok(children.some(j=>j.chart==='OCM W-Stack/'+chart));
 assert.ok(!jobs.some(j=>j.chart==='INFRA/network/cluster-issuer'||j.chart==='INFRA/network/external-dns'));
 assert.deepEqual(f.events,[{type:'application-set-revision',applicationSet:'ocm-wstack',upstreamDefault:'oid4vp',effectiveRevision:'main'}]);
});
test('unsupported matrix, directory, identity or namespace still stops planning',async t=>{
 for(const change of [s=>s['ocm-wstack'].matrix.enabled=true,s=>s['ocm-wstack'].path='OCM W-Stack/**',s=>s.core.name='other',s=>s.storage.namespace='other']){
  const f=await fixture(t,change);await assert.rejects(plan(f.runner,f.source,f.argoSource,f.c,f.directory),{code:'CHART_PLAN'});
 }
});
test('existing 12.3.7 bootstrap marker resumes with the reviewed October 9 baseline',async()=>{
 const {config,resolve,fingerprint}=require('../lib/config'),{ensureMarker}=require('../lib/install');
 const c={...resolve(config({procedureVersion:12,domain:'example.com'}),{items:[]},{items:[{metadata:{name:'standard',annotations:{'storageclass.kubernetes.io/is-default-class':'true'}}}]},{}),clusterUid:'cluster'};
 const previous='d87b061990160fa6a34cf97c98d1e6e2a4289e9b';
 const marker={metadata:{labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}},data:{instance:c.instanceName,clusterUid:c.clusterUid,fingerprint:fingerprint(c),upstreamCommit:previous,bootstrapComplete:'true'}};
 let writes=0;const r={json:async(cmd,args,opts)=>{if(args.includes('replace')){writes++;return JSON.parse(opts.input);}return marker;}};
 const out=await ensureMarker(r,c);assert.equal(writes,1);assert.equal(out.data.bootstrapComplete,'true');assert.equal(out.data.migratedFrom,previous);assert.equal(out.data.upstreamCommit,require('../upstream-lock.json').commit);
});
