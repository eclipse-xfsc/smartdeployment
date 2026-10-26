'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {jq}=require('./helpers.cjs');
const provider=(name,scope='Cluster',namespace='infrastructure')=>({kind:'ResourceProvider',metadata:{name,namespace},spec:{scope}});
const workload=(needs,namespace='ocm-wstack')=>({kind:'Deployment',metadata:{name:'consumer',namespace},spec:{template:{metadata:{annotations:{'inject.xfsc.io/enabled':'true','inject.xfsc.io/needs':needs}}}}});
test('provider contract resolves cluster and same-namespace providers and trims list entries',()=>{
 assert.deepEqual(jq('provider_contract_errors',[provider('nats'),provider('signer','Namespaced','ocm-wstack'),workload('nats, signer')]),[]);
});
test('provider contract reports misspelled Storage reference before installation',()=>{
 assert.deepEqual(jq('provider_contract_errors',[provider('storageservice'),workload('storage')]),[{workload:'ocm-wstack/consumer',provider:'storage'}]);
});
test('provider contract rejects a provider scoped to another namespace',()=>{
 assert.equal(jq('provider_contract_errors',[provider('signer','Namespaced','other'),workload('signer')]).length,1);
});
test('provider contract ignores workloads with injection disabled',()=>{
 const w=workload('missing');w.spec.template.metadata.annotations['inject.xfsc.io/enabled']='false';
 assert.deepEqual(jq('provider_contract_errors',[w]),[]);
});
const policy=require('./fixtures/policy-render.json');
test('Policy render contract accepts provider injection before NATS variables are injected',()=>{
 const checks=jq('policy_chart_checks',policy);assert.ok(Object.values(checks).every(v=>v===true),JSON.stringify(checks));
 const deployment=policy.find(d=>d.kind==='Deployment');
 assert.ok(!deployment.spec.template.spec.containers[0].env.some(e=>e.name==='NATS_URL'||e.name==='NATS_ADDR'));
});
test('Policy contract rejects the obsolete NATS variable replacement',()=>{
 const docs=structuredClone(policy);docs.find(d=>d.kind==='Deployment').spec.template.metadata.annotations['inject.xfsc.io/env-replacements']='{"NATS_URL":"NATS_ADDR"}';
 assert.equal(jq('policy_chart_checks',docs).providers,false);
});
test('Policy contract rejects a Service targeting the wrong port',()=>{
 const docs=structuredClone(policy);docs.find(d=>d.kind==='Service'&&d.metadata.name==='policy').spec.ports.forEach(p=>{p.targetPort=8222;});
 assert.equal(jq('policy_chart_checks',docs).servicePort,false);
});
