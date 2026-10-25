'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {adapt}=require('../lib/adapt');
const {Runner}=require('../lib/runner');

test('a healthy subset of an ApplicationSet cannot pass the bootstrap wait',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-appset-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.cp(path.join(__dirname,'fixtures/upstream'),dir,{recursive:true});await adapt(dir);
  const bin=path.join(dir,'bin');await fs.mkdir(bin);
  await fs.writeFile(path.join(bin,'kubectl'),`#!/usr/bin/env node
console.log(JSON.stringify({items:Array.from({length:Number(process.env.TEST_APP_COUNT)},(_,i)=>({metadata:{name:'component-'+i,ownerReferences:[{kind:'ApplicationSet',name:'storage',controller:true}]},status:{sync:{status:'Synced'},health:{status:'Healthy'}}}))}));
`,{mode:0o700});
  const r=new Runner({cwd:dir,env:{...process.env,PATH:bin+':'+process.env.PATH,TIMEOUT_SECONDS:'0',ESB_KUBE_READ:path.join(__dirname,'../scripts/kube-read.js'),ESB_APPSET_COUNTS:'{"storage":2}',TEST_APP_COUNT:'1'}});
  await assert.rejects(r.run('bash',['check-applicationset.sh','storage','argocd']),{code:'COMMAND_FAILED'});
  r.env.TEST_APP_COUNT='2';
  assert.equal((await r.run('bash',['check-applicationset.sh','storage','argocd'])).code,0);
});
