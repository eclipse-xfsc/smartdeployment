'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {TEMPLATE,transform}=require('../lib/openbao-bootstrap');
const fixture=path.join(__dirname,'fixtures/upstream',TEMPLATE);
const inputs={'.Release.Name':'openbao','.Release.Namespace':'security','.Values.provisioner.serviceAccount.name':'openbao-provisioner','.Values.provisioner.policyName':'openbao-provisioner','.Values.provisioner.roleName':'openbao-provisioner','.Values.provisioner.managedResourcePrefix':'xfsc-','.Values.provisioner.tokenTTL':'15m','.Values.provisioner.tokenMaxTTL':'1h','.Values.bootstrap.storeBootstrapMaterial':'true'};
function parse(text){
 const yaml=text.replace(/{{\s*(.*?)\s*}}/g,(_,key)=>{assert.ok(Object.hasOwn(inputs,key),key);return inputs[key];});
 const result=spawnSync('python3',['-c','import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],{input:yaml,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
// Local kubectl stand-in models the reported stdin EOF, executes the new remote
// POSIX shell with real argv/file I/O, and refuses unexpected bootstrap writes.
const peer=String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const args=process.argv.slice(2),root=process.env.ESB_TEST_DIR,mode=process.env.ESB_TEST_MODE,policy=path.join(root,'policy.hcl');
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify(args)+'\n');
const fail=message=>{process.stderr.write(message+'\n');process.exit(2);};
if(args[0]!=='-n'||args[1]!=='security'){
 if(args[0]==='label'&&args.includes('--local')){process.stdout.write(fs.readFileSync(0));process.exit(0);}
 if(args[0]==='apply'&&args.includes('-f')){fs.readFileSync(0);fs.writeFileSync(path.join(root,'discovery-written'),'yes');process.stdout.write('configured\n');process.exit(0);}
 fail('Unexpected namespace or command');
}
const command=args[2];
if(command==='get'){
 if(args[3]==='pod'){process.stdout.write(args.includes('-o')?'Running':'openbao-0');process.exit(0);}
 if(args[3]==='secret'){
  const key=args.at(-1).match(/\.data\.([^}]+)/)?.[1];
  const value=key==='root_token'?(mode==='missing-root'?'':'test-root-private'):'test-unseal-private';
  process.stdout.write(Buffer.from(value).toString('base64'));process.exit(0);
 }
 fail('Unexpected get');
}
if(command==='exec'){
 if(args[3]==='-i'){
  fs.readFileSync(0);fs.writeFileSync(policy,'');
  process.stderr.write('Copying stdin failed: EOF\n');process.exit(0);
 }
 if(args[3]!=='openbao-0')fail('Unexpected target pod');
 const remote=args.slice(args.indexOf('--')+1),script=remote[2]||'';
 if(script.includes('test -n "$1"')){
  if(mode==='transfer-fails')fail('simulated exec transport failure');
  if(remote.length!==6||remote[5]!=='/tmp/openbao-provisioner.hcl')fail('Unexpected policy argument/path');
  const result=spawnSync(remote[0],[remote[1],script,remote[3],remote[4],policy],{encoding:'utf8'});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);
 }
 if(script.includes('bao status')){process.stdout.write('Initialized true\nSealed false\n');process.exit(0);}
 if(/bao operator (init|unseal)/.test(script))fail('Existing material must not be regenerated or resealed');
 if(script.includes('bao policy write')){
  const data=fs.existsSync(policy)?fs.readFileSync(policy,'utf8'):'';
  if(!data.trim())fail("Code: 400. 'policy' parameter not supplied or empty");
  fs.writeFileSync(path.join(root,'installed.hcl'),data);process.exit(0);
 }
 if(script.includes('bao token lookup')||script.includes('bao auth enable')||script.includes("'auth/kubernetes/config'")||script.includes("'auth/kubernetes/role/openbao-provisioner'")||script.includes('bao policy read'))process.exit(0);
 fail('Unexpected remote command');
}
if(command==='create'&&args[3]==='configmap'){process.stdout.write('{"kind":"ConfigMap"}');process.exit(0);}
if(command==='apply'&&args.includes('-f')){fs.readFileSync(0);fs.writeFileSync(path.join(root,'discovery-written'),'yes');process.stdout.write('configured\n');process.exit(0);}
fail('Unexpected command');
`;
async function run(t,text,mode='ok'){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'esb-openbao-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'kubectl'),peer,{mode:0o700});
 const job=parse(text),script=job.spec.template.spec.containers[0].command[2];
 const result=spawnSync('/bin/bash',['-ec',script],{env:{...process.env,PATH:root+path.delimiter+process.env.PATH,ESB_TEST_DIR:root,ESB_TEST_MODE:mode},encoding:'utf8',timeout:15000});
 assert.ifError(result.error);assert.doesNotMatch(result.stdout+result.stderr,/test-root-private|test-unseal-private/);
 return {root,job,...result,calls:(await fs.readFile(path.join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)};
}
test('OpenBao repair retains native policy, initialization, validation and hook cleanup contracts',async()=>{
 const native=await fs.readFile(fixture,'utf8'),fixed=transform(native),old=parse(native),next=parse(fixed);
 const policy=native.split('<<POLICY_EOF\n')[1].split('              POLICY_EOF\n')[0];
 assert.ok(fixed.includes(policy));assert.equal(next.spec.template.spec.restartPolicy,'Never');assert.equal(next.spec.backoffLimit,3);
 assert.deepEqual(next.metadata,old.metadata);assert.equal(next.spec.template.spec.serviceAccountName,old.spec.template.spec.serviceAccountName);
 assert.equal(next.spec.template.spec.containers[0].image,old.spec.template.spec.containers[0].image);
 const before='              echo "Writing generic provisioner policy..."',after='              echo "Installing provisioner policy ${PROVISIONER_POLICY}..."';
 assert.equal(fixed.split(before)[0].replace('restartPolicy: Never','restartPolicy: OnFailure'),native.split(before)[0]);
 assert.equal(fixed.split(after)[1],native.split(after)[1]);
 const checked=spawnSync('bash',['-n'],{input:next.spec.template.spec.containers[0].command[2],encoding:'utf8'});assert.equal(checked.status,0,checked.stderr);
 assert.throws(()=>transform(native.replace('<<POLICY_EOF','<<CHANGED')),{code:'UPSTREAM_CONTRACT'});
});
test('reported stdin EOF reproduces an empty policy and fails the original bootstrap',async t=>{
 const r=await run(t,await fs.readFile(fixture,'utf8'));assert.equal(r.status,2);
 assert.match(r.stderr,/Copying stdin failed: EOF/);assert.match(r.stderr,/policy.*not supplied or empty/);
 assert.equal(await fs.readFile(path.join(r.root,'policy.hcl'),'utf8'),'');
});
test('repaired native bootstrap executes without stdin and installs the exact expanded policy',async t=>{
 const native=await fs.readFile(fixture,'utf8'),r=await run(t,transform(native));assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/OpenBao bootstrap completed/);assert.ok(r.calls.every(args=>!args.includes('-i')));
 const script=parse(native).spec.template.spec.containers[0].command[2];
 const expected=script.split('<<POLICY_EOF\n')[1].split('\nPOLICY_EOF')[0].replaceAll('${MANAGED_RESOURCE_PREFIX}','xfsc-').replaceAll('${KUBERNETES_AUTH_PATH}','kubernetes')+'\n';
 assert.equal(await fs.readFile(path.join(r.root,'installed.hcl'),'utf8'),expected);
 assert.equal((await fs.stat(path.join(r.root,'policy.hcl'))).mode&0o777,0o600);
 assert.equal(await fs.readFile(path.join(r.root,'discovery-written'),'utf8'),'yes');
});
test('failed argument transfer stops before policy installation or discovery writes',async t=>{
 const r=await run(t,transform(await fs.readFile(fixture,'utf8')),'transfer-fails');assert.notEqual(r.status,0);
 assert.equal(r.calls.some(args=>args.some(x=>x.includes('bao policy write'))),false);
 await assert.rejects(fs.access(path.join(r.root,'installed.hcl')));await assert.rejects(fs.access(path.join(r.root,'discovery-written')));
});
test('initialized OpenBao without its stored root token fails without reinitializing or rotating keys',async t=>{
 const r=await run(t,transform(await fs.readFile(fixture,'utf8')),'missing-root');assert.notEqual(r.status,0);
 assert.match(r.stdout,/no bootstrap root token is available/);
 assert.equal(r.calls.some(args=>args.some(x=>/bao operator (init|unseal)/.test(x))),false);
 await assert.rejects(fs.access(path.join(r.root,'installed.hcl')));
});
