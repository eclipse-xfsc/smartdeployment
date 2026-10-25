'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
function check(t,mode){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ocm-rollout-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 fs.writeFileSync(path.join(tmp,'kubectl'),'#!'+process.execPath+'\n'+`
 const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.OCM_TEST_LOG,JSON.stringify(args)+'\\n');
 if(args.includes('--all'))process.exit(99);
 if(args[2]==='get'&&args[3]==='deployments'){
  if(process.env.OCM_TEST_MODE==='list-error')process.exit(1);
  if(process.env.OCM_TEST_MODE!=='empty')process.stdout.write('deployment.apps/storage-service\\ndeployment.apps/signer\\n');
 }else if(args[2]==='rollout'&&process.env.OCM_TEST_MODE==='rollout-error')process.exit(1);
 `,{mode:0o755});
 const file=path.join(tmp,'calls');const r=spawnSync('bash',[path.resolve(__dirname,'../../scripts/wait-deployments.sh'),'ocm-wstack'],{encoding:'utf8',env:{...process.env,PATH:tmp+path.delimiter+process.env.PATH,OCM_TEST_LOG:file,OCM_TEST_MODE:mode}});
 return {r,calls:fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse)};
}
test('readiness enumerates each deployment and uses supported rollout arguments',t=>{const {r,calls}=check(t,'ok');assert.equal(r.status,0);assert.deepEqual(calls.slice(1).map(a=>a.slice(2)),[['rollout','status','deployment.apps/storage-service','--timeout=15m'],['rollout','status','deployment.apps/signer','--timeout=15m']]);});
test('deployment enumeration errors do not report success',t=>{const {r,calls}=check(t,'list-error');assert.notEqual(r.status,0);assert.equal(calls.length,1);});
test('failed rollout stops and provides pod diagnostics',t=>{const {r,calls}=check(t,'rollout-error');assert.notEqual(r.status,0);assert.match(r.stderr,/readiness failed/);assert.deepEqual(calls.at(-1).slice(2),['get','pods','-o','wide']);assert.equal(calls.filter(a=>a[2]==='rollout').length,1);});
test('empty deployment list does not invoke an invalid rollout command',t=>{const {r,calls}=check(t,'empty');assert.equal(r.status,0);assert.equal(calls.length,1);});
