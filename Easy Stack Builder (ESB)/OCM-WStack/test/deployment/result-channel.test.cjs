'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {ROOT,workspace}=require('./helpers.cjs');
for(const [name,operation,code] of [
  ['Argo wait failure','fail ARGO_SYNC_TIMEOUT "Verification did not synchronize."','ARGO_SYNC_TIMEOUT'],
  ['unexpected exit','false','COMMAND_FAILED'],
  ['explicit exit','exit 124','COMMAND_FAILED'],
  ['nested redirected failure','nested() { fail NATIVE_FAILED "Native check failed."; }; nested >"$WORKDIR/nested"','NATIVE_FAILED'],
]) test(`result channel survives ${name} during redirected deployment`,t=>{
  const dir=workspace(t);
  const r=spawnSync('bash',['-c',`
source "$ROOT/deploy.sh"
read_options() { OWNS_WORKDIR=true; trap cleanup EXIT; }
operation() { ${operation}; }
main deploy
`],{cwd:ROOT,env:{...process.env,ROOT,WORKDIR:dir},encoding:'utf8',timeout:10000});
  assert.notEqual(r.status,0);assert.equal(r.error,undefined);
  const result=JSON.parse(r.stdout);assert.equal(result.code,code);
  assert.equal(fs.existsSync(dir),false);
});
test('successful deployment returns exactly one JSON result',t=>{
  const dir=workspace(t);
  const r=spawnSync('bash',['-c',`
source "$ROOT/deploy.sh"
read_options() { OWNS_WORKDIR=true; trap cleanup EXIT; }
operation() { printf '{"status":"ready"}\\n'; }
main deploy
`],{cwd:ROOT,env:{...process.env,ROOT,WORKDIR:dir},encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{status:'ready'});
});

test('original failure survives a lease-cleanup exit and is saved outside the work directory',t=>{
  const dir=workspace(t),output=path.join(dir,'saved.json'),work=path.join(dir,'work');fs.mkdirSync(work);
  const r=spawnSync('bash',['-c',`
source "$ROOT/deploy.sh"
read_options() { OWNS_WORKDIR=true; ESB_LEASE_HOLDER=ours; trap cleanup EXIT; }
release_lease() { exit 9; }
operation() { fail ARGO_SYNC_TIMEOUT "Verification did not synchronize."; }
main deploy
`],{cwd:ROOT,env:{...process.env,ROOT,WORKDIR:work,ESB_RESULT_FILE:output},encoding:'utf8',timeout:10000});
  assert.equal(r.status,9);assert.equal(JSON.parse(r.stdout).code,'ARGO_SYNC_TIMEOUT');
  assert.equal(JSON.parse(fs.readFileSync(output)).code,'ARGO_SYNC_TIMEOUT');
  assert.equal(fs.statSync(output).mode & 0o777,0o600);
});
for(const [name,body] of [['empty',':'],['multiple',`printf '{}\\n{}\\n'`]])
  test(`${name} action output produces a structured failure`,t=>{
    const dir=workspace(t);
    const r=spawnSync('bash',['-c',`
source "$ROOT/deploy.sh"
read_options() { OWNS_WORKDIR=true; trap cleanup EXIT; }
operation() { ${body}; }
main deploy
`],{cwd:ROOT,env:{...process.env,ROOT,WORKDIR:dir},encoding:'utf8',timeout:10000});
    assert.notEqual(r.status,0);assert.equal(JSON.parse(r.stdout).code,'ACTION_RESULT');
  });
