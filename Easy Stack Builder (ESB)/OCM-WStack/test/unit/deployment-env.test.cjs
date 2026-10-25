'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
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
test('kubectl receives JSON patch over stdin, never strategic merge',()=>{const calls=[];apply('ns','svc','retrieval',{HOSTS:'db'},(args,input)=>{calls.push({args,input});return JSON.stringify(fixture());});assert.equal(calls.length,2);assert.ok(calls[1].args.includes('--type=json'));assert.ok(calls[1].args.includes('--patch-file=/dev/stdin'));assert.equal(JSON.parse(calls[1].input)[0].op,'test');});
test('patch rejection propagates and is never reported as success',()=>{assert.throws(()=>apply('ns','svc','retrieval',{HOSTS:'db'},(args)=>{if(args.includes('get'))return JSON.stringify(fixture());throw new Error('resourceVersion changed');}),/resourceVersion changed/);});
