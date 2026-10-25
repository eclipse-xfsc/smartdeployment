'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const ocm=require('../lib/ocm'),core=require('../lib/ocm-guard-core');
function rule(){
 const parsed=spawnSync('python3',['-c','import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],{input:ocm.routingValues().esbTemplatePatch,encoding:'utf8'});
 assert.equal(parsed.status,0,parsed.stderr);
 const doc=JSON.parse(parsed.stdout),rules=doc.spec.ignoreDifferences.filter(r=>r.name===core.VERIFICATION);
 assert.equal(rules.length,1);assert.equal(rules[0].group,'apps');assert.equal(rules[0].kind,'Deployment');assert.equal(rules[0].namespace,'ocm-wstack');
 assert.equal(rules[0].jqPathExpressions.length,4);assert.equal(rules[0].jsonPointers,undefined);assert.equal(rules[0].managedFieldsManagers,undefined);
 assert.ok(doc.spec.syncPolicy.syncOptions.includes('RespectIgnoreDifferences=true'));return rules[0];
}
function normalize(d){
 const result=spawnSync('jq',['-c',rule().jqPathExpressions.map(x=>`del(${x})`).join(' | ')],{input:JSON.stringify(d),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
function deployment(){return {apiVersion:'apps/v1',kind:'Deployment',metadata:{name:core.VERIFICATION,namespace:'ocm-wstack'},spec:{template:{spec:{containers:[
 {name:core.VERIFICATION,image:'native:reviewed',env:[{name:'DID_RESOLVER',value:'http://resolver:8080'},...Object.entries(core.VERIFICATION_NATS_ENV).map(([name,value])=>({name,value})),{name:'CREDENTIALVERIFICATION_CASSANDRAPASSWORD',valueFrom:{secretKeyRef:{name:'database',key:'password'}}}],readinessProbe:{httpGet:{path:'/v1/metrics/health',port:8080}}},
 {name:'sidecar',env:[{name:'CREDENTIALVERIFICATION_NATS_PORT',value:'must-remain'}]}
 ]}}}};}
test('actual JQ normalization removes only the four reported entries and tolerates their relocation',()=>{
 const desired=deployment(),live=structuredClone(desired),env=live.spec.template.spec.containers[0].env;
 env.push(...env.splice(1,4).reverse());assert.notDeepEqual(live,desired);assert.deepEqual(normalize(live),normalize(desired));
 const normalized=normalize(live);assert.equal(normalized.spec.template.spec.containers[0].env.length,2);
 assert.deepEqual(normalized.spec.template.spec.containers[1],live.spec.template.spec.containers[1]);
 for(const name of Object.keys(core.VERIFICATION_NATS_ENV))assert.ok(rule().jqPathExpressions.some(x=>x.endsWith(`select(.name == "${name}")`)));
});
test('images, probes, native configuration and secret references remain visible to Argo comparison',()=>{
 const original=deployment();
 for(const change of [d=>{d.spec.template.spec.containers[0].image='changed:tag';},d=>{d.spec.template.spec.containers[0].env[0].value='changed';},d=>{d.spec.template.spec.containers[0].env.at(-1).valueFrom.secretKeyRef.name='changed';},d=>{d.spec.template.spec.containers[0].readinessProbe.httpGet.path='/changed';},d=>{d.spec.template.spec.containers[1].env[0].value='changed';}]){
  const changed=structuredClone(original);change(changed);assert.notDeepEqual(normalize(changed),normalize(original));
 }
});
