'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {plan,apply}=require('../../scripts/deployment-env.cjs');
const fixture=()=>({metadata:{resourceVersion:'17'},spec:{template:{spec:{imagePullSecrets:[{}],containers:[{name:'sidecar',env:[{name:'KEEP',value:'yes'}]},{name:'retrieval',env:[{name:'PASSWORD',valueFrom:{secretKeyRef:{name:'cassandra',key:'password'}}},{name:'HOST',value:'old'}]}]}}}});
test('JSON env patch preserves malformed unrelated lists and targets named container',()=>{
 const d=fixture(),before=JSON.stringify(d),p=plan(d,'retrieval',{HOSTS:'db:9042'});
 assert.equal(JSON.stringify(d),before);assert.equal(p.length,2);
 assert.deepEqual(p[0],{op:'test',path:'/metadata/resourceVersion',value:'17'});
 assert.equal(p[1].path,'/spec/template/spec/containers/1/env');
 assert.deepEqual(p[1].value[0],d.spec.template.spec.containers[1].env[0]);
 assert.deepEqual(p[1].value.at(-1),{name:'HOSTS',value:'db:9042'});
});
test('replaces all duplicates of updated env and repeated application is a no-op',()=>{
 const d=fixture();d.spec.template.spec.containers[1].env.push({name:'HOST',valueFrom:{secretKeyRef:{name:'old',key:'old'}}});
 const p=plan(d,'retrieval',{HOST:'new'});assert.equal(p[1].value.filter(e=>e.name==='HOST').length,1);
 d.spec.template.spec.containers[1].env=p[1].value;assert.deepEqual(plan(d,'retrieval',{HOST:'new'}),[]);
});
test('supports a container without env',()=>{const d=fixture();delete d.spec.template.spec.containers[1].env;assert.deepEqual(plan(d,'retrieval',{X:'a=b'})[1].value,[{name:'X',value:'a=b'}]);});
test('refuses missing or ambiguous container and missing concurrency guard',()=>{const d=fixture();assert.throws(()=>plan(d,'missing',{X:'v'}));d.spec.template.spec.containers.push({name:'retrieval'});assert.throws(()=>plan(d,'retrieval',{X:'v'}));delete d.metadata.resourceVersion;assert.throws(()=>plan(d,'sidecar',{X:'v'}));});
test('kubectl reads a private JSON patch file which is removed after success',()=>{
 const calls=[];let file;
 apply('ns','svc','retrieval',{HOSTS:'db'},args=>{
  calls.push(args);if(args.includes('get'))return JSON.stringify(fixture());
  assert.ok(args.includes('--type=json'));file=args[args.indexOf('--patch-file')+1];
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8'))[0].op,'test');
 });
 assert.equal(calls.length,2);assert.equal(fs.existsSync(path.dirname(file)),false);
});
test('patch rejection propagates and is never reported as success',()=>{assert.throws(()=>apply('ns','svc','retrieval',{HOSTS:'db'},(args)=>{if(args.includes('get'))return JSON.stringify(fixture());throw new Error('resourceVersion changed');}),/resourceVersion changed/);});
function subprocessCase(t,fail){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ocm-env-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const record=path.join(directory,'file-record');
 fs.writeFileSync(path.join(directory,'kubectl'),'#!'+process.execPath+'\n'+`
  const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
  const args=process.argv.slice(2);
  if(args.includes('get')){process.stdout.write(${JSON.stringify(JSON.stringify(fixture()))});}
  else {
   assert.ok(args.includes('--type=json'));
   const file=args[args.indexOf('--patch-file')+1];
   assert.ok(file && file!=='/dev/stdin');
   fs.writeFileSync(process.env.OCM_PATCH_RECORD,file);
   const patch=JSON.parse(fs.readFileSync(file,'utf8'));
   assert.equal(fs.statSync(file).isFile(),true);
   assert.equal(fs.statSync(file).mode&0o777,0o600);
   assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);
   assert.equal(patch[0].value,'17');
   assert.deepEqual(patch[1].value.at(-1),{name:'HOSTS',value:'db:9042'});
   if(process.env.OCM_PATCH_FAIL==='1'){process.stderr.write('fixture patch rejected');process.exit(1);}
   process.stdout.write('deployment patched');
  }
 `,{mode:0o755});
 const r=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/deployment-env.cjs'),'ns','svc','retrieval','HOSTS=db:9042'],{encoding:'utf8',env:{...process.env,PATH:directory+path.delimiter+process.env.PATH,OCM_PATCH_RECORD:record,OCM_PATCH_FAIL:fail?'1':'0'}});
 assert.equal(r.status,fail?1:0,r.stderr);
 assert.equal(fs.existsSync(path.dirname(fs.readFileSync(record,'utf8'))),false);
 if(fail){assert.match(r.stderr,/fixture patch rejected/);assert.doesNotMatch(r.stdout,/updated/);}else assert.match(r.stdout,/environment updated/);
}
test('real Node child process opens regular patch file successfully',t=>subprocessCase(t,false));
test('real Node child process failure cleans up patch directory',t=>subprocessCase(t,true));
