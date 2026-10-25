'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {redisMirror,unhealthy,health}=require('../lib/argo');
test('Redis mirror preserves the exact tag and leaves other images untouched',()=>{
 const source='image: public.ecr.aws/docker/library/redis:8.2.3-alpine\nimage: quay.io/argoproj/argocd:v3.5.3\n';
 assert.equal(redisMirror(source),'image: docker.io/library/redis:8.2.3-alpine\nimage: quay.io/argoproj/argocd:v3.5.3\n');
});
const pod=ready=>({metadata:{name:'redis'},status:{phase:'Running',containerStatuses:[{name:'redis',ready,state:{waiting:{reason:'ImagePullBackOff'}}}]}});
test('Running pod with unready containers is unhealthy; completed and terminating pods are ignored',()=>{
 assert.equal(unhealthy({items:[pod(false)]}).length,1);assert.equal(unhealthy({items:[pod(true)]}).length,0);
 assert.deepEqual(unhealthy({items:[{metadata:{deletionTimestamp:'now'},status:{phase:'Pending'}},{status:{phase:'Succeeded'}}]}),[]);
});
test('health waits for all containers to be ready rather than just Running',async()=>{
 let calls=0,clock=0;const events=[];const r={emit:e=>events.push(e),redact:x=>x,run:async()=>({stdout:JSON.stringify({items:[pod(++calls>1)]})})};
 await health(r,{timeoutSeconds:10,now:()=>clock,sleep:async ms=>{clock+=ms;}});assert.equal(calls,2);assert.equal(events[0].pods[0].containers[0].reason,'ImagePullBackOff');
});
test('empty Argo namespace cannot pass readiness',async()=>{
 let clock=0;const r={emit:()=>{},redact:x=>x,run:async()=>({stdout:'{"items":[]}'})};
 await assert.rejects(health(r,{timeoutSeconds:1,now:()=>clock,sleep:async ms=>{clock+=ms;}}),{code:'ARGO_PODS_UNREADY'});
});
