'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {read,MAX_FORBIDDEN_RETRIES}=require('../lib/kube-read');
const {Runner}=require('../lib/runner');
const endpoint='/apis/argoproj.io/v1alpha1/namespaces/argocd/applications';
const username='system:serviceaccount:kube-system:cluster-admin';
const denied=()=>Object.assign(Error('kubectl exited 1. Error from server (Forbidden): applications.argoproj.io is forbidden'),{code:'COMMAND_FAILED'});
function fixture({forbidden=1,allowed=true,actual=username,status}={}) {
 let time=0,gets=0;const events=[],calls=[],sleeps=[];
 const r={env:{ESB_KUBE_USERNAME:username},redact:x=>x,emit:e=>events.push(e),run:async(cmd,args,options)=>{
  calls.push({cmd,args,options});gets++;if(gets<=forbidden)throw denied();return {stdout:'{"kind":"ApplicationList","items":[{"metadata":{"name":"cassandra"}}]}'};
 },json:async(cmd,args,options)=>{
  calls.push({cmd,args,options});
  if(args.includes('whoami'))return {status:{userInfo:{username:actual}}};
  assert.deepEqual(JSON.parse(options.input).spec.resourceAttributes,{group:'argoproj.io',version:'v1alpha1',resource:'applications',verb:'list',namespace:'argocd'});
  return {status:status||{allowed}};
 }};
 const options={now:()=>time,sleep:async ms=>{sleeps.push(ms);time+=ms;}};
 return {r,options,events,calls,sleeps,gets:()=>gets,setTime:n=>time=n};
}
test('one Forbidden read rechecks exact identity/access, retries and requires real list success',async()=>{
 const f=fixture();const doc=await read(f.r,endpoint,f.options);
 assert.equal(doc.items.length,1);assert.equal(f.gets(),2);assert.deepEqual(f.sleeps,[5000]);
 assert.deepEqual(f.events.at(-1),{type:'api-read-recovered',endpoint,forbiddenResponses:1});
 assert.equal(f.events.find(e=>e.type==='kube-access').phase,'argo-read-recheck');
 assert.ok(f.calls.every(c=>c.cmd==='kubectl'));assert.ok(!f.calls.some(c=>c.args.includes('apply')||c.args.includes('patch')));
});
test('actual authorization denial stops without retrying the read or sleeping',async()=>{
 const f=fixture({allowed:false});await assert.rejects(read(f.r,endpoint,f.options),{code:'RBAC'});
 assert.equal(f.gets(),1);assert.deepEqual(f.sleeps,[]);assert.equal(f.events.at(-1).allowed,false);
});
test('identity change, missing identity and malformed review cannot qualify for retry',async()=>{
 const f=fixture({actual:'other-user'});await assert.rejects(read(f.r,endpoint,f.options),{code:'KUBE_IDENTITY_CHANGED'});
 assert.equal(f.calls.length,2);assert.equal(f.gets(),1);
 const missing=fixture();missing.r.env={};await assert.rejects(read(missing.r,endpoint,missing.options),{code:'KUBE_IDENTITY'});assert.equal(missing.calls.length,1);
 for(const status of [{},{allowed:true,denied:true}]){
  const bad=fixture({status});await assert.rejects(read(bad.r,endpoint,bad.options),e=>['RBAC_RESPONSE','RBAC'].includes(e.code));assert.equal(bad.gets(),1);assert.equal(bad.sleeps.length,0);
 }
});
test('persistently inconsistent responses stop after three retries, retain resources and expose discrepancy',async()=>{
 const f=fixture({forbidden:99});await assert.rejects(read(f.r,endpoint,f.options),e=>e.code==='ARGO_ACCESS_INCONSISTENT'&&e.message.includes('Forbidden 4 times')&&e.message.includes(username)&&e.message.includes('Resources retained'));
 assert.equal(f.gets(),MAX_FORBIDDEN_RETRIES+1);assert.equal(f.sleeps.length,MAX_FORBIDDEN_RETRIES);assert.ok(!f.events.some(e=>e.type==='api-read-recovered'));
});
test('Unauthorized, TLS failures and Forbidden outside the Argo list paths remain immediate failures',async()=>{
 for(const [target,message] of [[endpoint,'Unauthorized'],[endpoint,'x509: certificate failure'],['/api/v1/namespaces/argocd/pods','Forbidden']]){
  const f=fixture();const error=Object.assign(Error(message),{code:'COMMAND_FAILED'});f.r.run=async()=>{throw error;};
  await assert.rejects(read(f.r,target,f.options),e=>e===error);assert.equal(f.calls.length,0);assert.equal(f.sleeps.length,0);
 }
});
test('identity, review and retry delay share the original read deadline',async()=>{
 const f=fixture();const original=f.r.json;f.r.json=async(cmd,args,options)=>{
  assert.ok(options.timeout<=900);const result=await original(cmd,args,options);f.setTime(args.includes('whoami')?500:800);return result;
 };
 await assert.rejects(read(f.r,endpoint,{...f.options,timeoutSeconds:0.9}),{code:'ARGO_API_UNAVAILABLE'});
 assert.equal(f.gets(),1);assert.deepEqual(f.sleeps,[100]);assert.ok(!f.events.some(e=>e.type==='api-read-recovered'));
});
test('real helper subprocess retries using the explicit uploaded binding and preserves recovery events',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-read-retry-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const config=path.join(dir,'uploaded.yaml'),cli=path.join(dir,'kubectl-test'),count=path.join(dir,'count');await fs.writeFile(config,'test-only');
 const source=`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args[0]!=='--kubeconfig'||args[1]!==process.env.ESB_KUBECONFIG||args[2]!=='--context'||args[3]!=='uploaded'){console.error('incorrect credential binding');process.exit(91);}
if(args.includes('whoami'))console.log(JSON.stringify({status:{userInfo:{username:process.env.ESB_KUBE_USERNAME}}}));
else if(args.includes('create')){
 let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{const a=JSON.parse(body).spec.resourceAttributes;if(a.version!=='v1alpha1'||a.verb!=='list'){process.exitCode=92;return;}console.log(JSON.stringify({status:{allowed:true}}));});
}else{
 const file=process.env.ESB_TEST_READ_COUNT;const n=fs.existsSync(file)?Number(fs.readFileSync(file)):0;fs.writeFileSync(file,String(n+1));
 if(n===0){console.error('Error from server (Forbidden): applications.argoproj.io is forbidden');process.exitCode=1;}
 else console.log(JSON.stringify({kind:'ApplicationList',items:[]}));
}
`;
 await fs.writeFile(cli,source,{mode:0o700});const events=[];
 const env={...process.env,KUBECONFIG:'/ambient/invalid',ESB_KUBECONFIG:config,ESB_KUBE_CONTEXT:'uploaded',ESB_REAL_KUBECTL:cli,ESB_REAL_HELM:cli,ESB_KUBE_USERNAME:username,ESB_TEST_READ_COUNT:count,ESB_READ_TIMEOUT_SECONDS:'30'};
 const r=new Runner({env,emit:e=>events.push(e)});
 const result=await r.run(process.execPath,[path.join(__dirname,'../scripts/kube-read.js'),endpoint],{live:true});
 assert.deepEqual(JSON.parse(result.stdout),{kind:'ApplicationList',items:[]});assert.equal(await fs.readFile(count,'utf8'),'2');
 assert.ok(events.some(e=>e.type==='api-read-retry'));assert.ok(events.some(e=>e.type==='api-read-recovered'&&e.forbiddenResponses===1));
 assert.ok(events.some(e=>e.type==='kube-access'&&e.allowed&&e.attributes.version==='v1alpha1'));
});
