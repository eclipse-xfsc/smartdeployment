'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {ROOT,workspace}=require('./helpers.cjs');
for(const [name,health,sync,revision,count,expected] of [
 ['credential-verification-service-chart','Healthy','OutOfSync','pinned',1,0],
 ['credential-verification-service-chart','Degraded','OutOfSync','pinned',1,1],
 ['credential-verification-service-chart','Healthy','Unknown','pinned',1,1],
 ['storage-service','Healthy','OutOfSync','pinned',1,1],
 ['credential-verification-service-chart','Healthy','OutOfSync','other',1,1],
 ['credential-verification-service-chart','Healthy','OutOfSync','pinned',2,1],
]) test(`ApplicationSet wait: ${name} ${health}/${sync} revision=${revision} expected=${count}`,t=>{
 const dir=workspace(t);fs.cpSync(path.join(ROOT,'test/fixtures/upstream'),path.join(dir,'source'),{recursive:true});
 let r=spawnSync('git',['apply',path.join(ROOT,'deployment/upstream.patch')],{cwd:path.join(dir,'source'),encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 fs.symlinkSync(path.join(ROOT,'deployment'),path.join(dir,'deployment'),'dir');
 fs.writeFileSync(path.join(dir,'hook.sh'),'#!/bin/bash\ncase "$2" in argo-access) exit 0;; kube-read) cat "$FIXTURE";; *) exit 9;; esac\n');
 fs.writeFileSync(path.join(dir,'apps.json'),JSON.stringify({items:[{metadata:{name,annotations:{'test-padding':'x'.repeat(150000)},ownerReferences:[{kind:'ApplicationSet',name:'ocm-wstack',controller:true}]},spec:{source:{repoURL:'https://github.com/eclipse-xfsc/deployment.git',targetRevision:revision}},status:{health:{status:health},sync:{status:sync,comparedTo:{source:{targetRevision:revision}}},operationState:{phase:'Running'}}}]}));
 r=spawnSync('bash',['-c','exec 3>"$EVENTS"; bash "$CHECK" ocm-wstack argocd'],{env:{...process.env,ESB_DEPLOY:path.join(dir,'hook.sh'),FIXTURE:path.join(dir,'apps.json'),EVENTS:path.join(dir,'events'),CHECK:path.join(dir,'source/check-applicationset.sh'),TIMEOUT_SECONDS:'0',ESB_APPSET_COUNTS:JSON.stringify({'ocm-wstack':count}),ESB_DEPLOYMENT_REVISION:'pinned'},encoding:'utf8',timeout:5000});
 assert.equal(r.status,expected,r.stderr);
 if(expected===0){const event=JSON.parse(fs.readFileSync(path.join(dir,'events'),'utf8').trim().split('\n').at(-1));assert.equal(event.acceptedSyncDifferences[0].sync,'OutOfSync');}
});
