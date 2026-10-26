'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { ROOT, jq, workspace, bash } = require('./helpers.cjs');

// Contract inputs derived from the 1.2.2-alpha.helm templates. test:helm
// renders the supplied chart archive and runs the same checks on its output.
function documents() {
  const secret = (name, key) => ({valueFrom:{secretKeyRef:{name,key}}});
  const entries = {
    CREDENTIALVERIFICATION_STATESIGNINGKEY:secret('credential-verification-service-state-signing','state-signing-key'),
    CREDENTIALVERIFICATION_CASSANDRA_USER:secret('verification-cassandra-credentials','username'),
    CREDENTIALVERIFICATION_CASSANDRA_PASSWORD:secret('verification-cassandra-credentials','password'),
    CREDENTIALVERIFICATION_STORAGE_URL:{value:'http://storage-service.ocm-wstack.svc.cluster.local:8080'},
    CREDENTIALVERIFICATION_PROTOCOL:{value:'nats'},
    CREDENTIALVERIFICATION_NATS_REQUEST_TIMEOUT:{value:'10'},
    CREDENTIALVERIFICATION_EXTERNALPRESENTATION_ENABLED:{value:'true'},
    CREDENTIALVERIFICATION_EXTERNALPRESENTATION_AUTHORIZEENDPOINT:{value:'http://credential-verification-service.ocm-wstack.svc.cluster.local:8080/v1/tenants/demo-tenant/presentation/'},
  };
  return [
    {kind:'Deployment',metadata:{name:'credential-verification-service'},spec:{template:{metadata:{annotations:{
      'inject.xfsc.io/enabled':'true','inject.xfsc.io/env-prefix':'CREDENTIALVERIFICATION',
      'inject.xfsc.io/needs':'nats,cassandra,signer,did-resolver,storageservice',
    }},spec:{imagePullSecrets:[{name:'esb-ocm-public-registry'}],containers:[{name:'credential-verification-service',env:Object.entries(entries).map(([name,v])=>({name,...v}))}]}}}},
    {kind:'Secret',metadata:{name:'credential-verification-service-state-signing'},data:{'state-signing-key':Buffer.from('test-only-state-key').toString('base64')}},
    {kind:'ResourceClaim',spec:{type:'cassandra',providerRef:{name:'cassandra'},externalSecretRef:{name:'verification-cassandra-credentials'},parameters:{keyspace:'ocm'}}},
  ];
}
const env = docs => docs[0].spec.template.spec.containers[0].env;
const field = (docs,name) => env(docs).find(e=>e.name==='CREDENTIALVERIFICATION_'+name);
test('verification chart contract accepts native provider and secret references',()=>{
  const checks=jq('verification_chart_checks',documents());
  assert.ok(Object.values(checks).every(v=>v===true),JSON.stringify(checks));
  assert.equal(jq('validate_chart("OCM W-Stack/Credential Verification Service Chart")',documents()),true);
});
for(const [name,mutate] of [
  ['providerInjection',d=>{d[0].spec.template.metadata.annotations['inject.xfsc.io/needs']='nats';}],
  ['providerInjection',d=>{d[0].spec.template.metadata.annotations['inject.xfsc.io/env-replacements']='{"NATS_URL":"MESSAGING_NATS_URL"}';}],
  ['stateSigningSecret',d=>{field(d,'STATESIGNINGKEY').valueFrom.secretKeyRef.key='old-key';}],
  ['stateSigningSecret',d=>{d.splice(1,1);}],
  ['cassandraCredentials',d=>{field(d,'CASSANDRA_PASSWORD').valueFrom.secretKeyRef.name='unrelated';}],
  ['cassandraClaim',d=>{d[2].spec.parameters.keyspace='other';}],
  ['storageEndpoint',d=>{field(d,'STORAGE_URL').value='http://credential-storage-service.default.svc.cluster.local:8080';}],
  ['natsTimeout',d=>{field(d,'NATS_REQUEST_TIMEOUT').value='10s';}],
  ['externalPresentation',d=>{field(d,'EXTERNALPRESENTATION_AUTHORIZEENDPOINT').value='http://NAMESPACE/presentation/';}],
  ['noIngress',d=>{d.push({kind:'Ingress'});}],
]) test(`verification chart rejects changed ${name}`,()=>{
  const d=documents(); mutate(d); assert.equal(jq('verification_chart_checks',d)[name],false);
  assert.equal(jq('validate_chart("OCM W-Stack/Credential Verification Service Chart")',d),false);
});
test('missing verification Deployment reports a failed named check',()=>{
  assert.equal(jq('verification_chart_checks',[]).deployment,false);
});
test('verification chart failure identifies the mismatched field',t=>{
  const d=documents(); field(d,'NATS_REQUEST_TIMEOUT').value='changed';
  const dir=workspace(t,{'documents.json':d});
  const result=bash(dir,'rendered_documents() { cp "$WORKDIR/documents.json" "$2"; }; validate_chart_manifests ignored "OCM W-Stack/Credential Verification Service Chart" verification');
  assert.notEqual(result.status,0);
  const error=JSON.parse(fs.readFileSync(dir+'/error.json'));
  assert.equal(error.code,'CHART_CONTRACT');
  assert.equal(error.message,'OCM W-Stack/Credential Verification Service Chart checks failed: natsTimeout.');
});
test('live verification NATS contract uses provider URL and duration',()=>{
  const d=documents()[0];
  for(const [name,value] of Object.entries(jq('verification_nats_environment',{}))) {
    const old=env([d]).find(e=>e.name===name);
    if(old) old.value=value; else env([d]).push({name,value});
  }
  assert.equal(jq('verification_nats_contract',d),true);
  field([d],'NATS_REQUEST_TIMEOUT').value='10';
  assert.equal(jq('verification_nats_contract',d),false);
});
test('supplied verification archive matches recorded content digest',()=>{
  const base=ROOT+'/test/fixtures/verification-1.2.2/';
  const p=JSON.parse(fs.readFileSync(base+'provenance.json'));
  const files=fs.readdirSync(base).filter(n=>n.endsWith('.tgz'));
  assert.equal(files.length,1);
  assert.ok(Object.values(p).includes(crypto.createHash('sha256').update(fs.readFileSync(base+files[0])).digest('hex')));
});
