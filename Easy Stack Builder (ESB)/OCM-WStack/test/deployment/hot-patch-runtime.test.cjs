'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('runtime hot patch keeps uploaded kubeconfig, resource scope, backups, rollback and concurrency guards',()=>{
 const result=spawnSync('python3',[path.join(__dirname,'hot-patch-runtime.py')],{encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
