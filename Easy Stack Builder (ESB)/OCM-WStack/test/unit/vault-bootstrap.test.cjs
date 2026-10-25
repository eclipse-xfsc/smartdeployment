'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {plan,bootstrap,runner}=require('../../scripts/vault-bootstrap.cjs');
function fakeVault(existing={},keys={}){
 const mounts=structuredClone(existing),stored=structuredClone(keys),calls=[];
 const ok=value=>({status:0,stdout:JSON.stringify(value),stderr:''});
 const run=async(args,input)=>{
  calls.push({args,input});const [verb,action]=args;
  if(verb==='secrets'&&action==='list')return ok(mounts);
  if(verb==='secrets'&&action==='enable'){
   const mount=args[2].slice('-path='.length)+'/';
   if(Object.keys(mounts).some(x=>x.startsWith(mount)||mount.startsWith(x)))return {status:2,stderr:'path is already in use',stdout:''};
   mounts[mount]={type:'transit'};return ok({});
  }
  if(verb==='read')return stored[args[2]]?ok({data:stored[args[2]]}):{status:2,stderr:'No value found at '+args[2]+'\ncommand terminated with exit code 2\n',stdout:''};
  if(verb==='write'){stored[args[2]]={type:'ecdsa-p256',keyMaterial:'new-'+args[2]};return ok({});}
  if(verb==='policy')return ok({});
  throw Error('Unexpected Vault command '+args.join(' '));
 };
 return {mounts,stored,calls,run};
}
test('fresh installation creates nonoverlapping root mounts, then second run reuses keys',async()=>{
 const v=fakeVault({'sys/':{type:'system'}});await bootstrap('ocm-wstack',v.run);
 assert.deepEqual(Object.keys(v.mounts).sort(),['ocm-wstack/','sys/','tenant_space/','transit/']);
 assert.equal(Object.keys(v.stored).length,10);const saved=structuredClone(v.stored);v.calls.length=0;
 await bootstrap('ocm-wstack',v.run);assert.deepEqual(v.stored,saved);
 assert.equal(v.calls.filter(c=>c.args[0]==='write'||c.args[1]==='enable').length,0);
});
test('reported partial deployment resumes without replacing keys or creating a child mount',async()=>{
 const v=fakeVault({'ocm-wstack/':{type:'transit'},'tenant_space/':{type:'transit'},'transit/':{type:'transit'}},Object.fromEntries(['signerkey','DeveloperCredential','SDJWTCredential','eckey','storagekey'].map(k=>['ocm-wstack/keys/'+k,{type:'ecdsa-p256',keyMaterial:'preserved-'+k}])));
 const original=structuredClone(v.stored);await bootstrap('ocm-wstack',v.run);
 for(const [k,value]of Object.entries(original))assert.deepEqual(v.stored[k],value);
 assert.ok(!v.calls.some(c=>c.args.some(a=>a.includes('ocm-wstack/tenant_space'))));
 assert.ok(!v.calls.some(c=>['disable','move','rotate','delete'].some(a=>c.args.includes(a))));
});
test('incompatible mount type fails before any mutation',async()=>{
 const v=fakeVault({'ocm-wstack/':{type:'kv'}});await assert.rejects(bootstrap('ocm-wstack',v.run),/refusing to replace/);assert.equal(v.calls.length,1);
});
test('existing child mount fails safely without changing engines',async()=>{
 const v=fakeVault({'ocm-wstack/other/':{type:'transit'}});await assert.rejects(bootstrap('ocm-wstack',v.run),/conflicts/);assert.equal(v.calls.length,1);
});
test('403 errors are never interpreted as missing keys',async()=>{
 const v=fakeVault({'ocm-wstack/':{type:'transit'},'tenant_space/':{type:'transit'},'transit/':{type:'transit'}});
 await assert.rejects(bootstrap('ocm-wstack',async args=>args[0]==='read'?{status:2,stderr:'Error reading: Code: 403. permission denied'}:v.run(args)),/403/);
 assert.ok(!v.calls.some(c=>c.args[0]==='write'));
});
test('mount enable failure stops bootstrap before key creation',async()=>{
 const v=fakeVault();await assert.rejects(bootstrap('ocm-wstack',async args=>args[1]==='enable'?{status:2,stderr:'sealed'}:v.run(args)),/sealed/);assert.ok(!v.calls.some(c=>c.args[0]==='write'));
});
test('incompatible existing key is retained and reported',async()=>{
 const v=fakeVault({'ocm-wstack/':{type:'transit'}},{'ocm-wstack/keys/signerkey':{type:'ed25519',keyMaterial:'keep'}});
 await assert.rejects(bootstrap('ocm-wstack',v.run),/incompatible type/);assert.equal(v.stored['ocm-wstack/keys/signerkey'].keyMaterial,'keep');
});
test('token is absent from process arguments and redacted from failures',()=>{
 let captured;const token='secret-test-token';const run=runner('ocm-wstack',token,(exe,args,opts)=>{captured={exe,args,opts};return {status:2,stderr:'error '+token};});
 const result=run(['policy','write','p','-'],'policy text');assert.ok(!captured.args.join(' ').includes(token));assert.equal(captured.opts.input,token+'\npolicy text');assert.ok(!result.stderr.includes(token));
});
test('holder and Storage target the root crypto mount while OCM group is preserved',()=>{
 const root=path.resolve(__dirname,'../..'),storage=fs.readFileSync(path.join(root,'Storage Service/values.yaml'),'utf8'),install=fs.readFileSync(path.join(root,'scripts/runtime-install.cjs'),'utf8');
 assert.match(storage,/namespace: NAMESPACE\n\s+group: ''/);assert.match(install,/cryptoNamespace:ns,cryptoGroup:''/);assert.match(install,/group:'ocm-wstack'/);
 assert.ok(plan('ocm-wstack').has('ocm-wstack'));assert.ok(!plan('ocm-wstack').has('ocm-wstack/tenant_space'));
});
