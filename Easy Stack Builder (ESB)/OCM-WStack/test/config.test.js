'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {config,provider,storageClass,resolve,kubeconfigText}=require('../lib/config');
const {networkValues}=require('../lib/adapt');
const example=require('../examples/deployment.json');
const classes={items:[{metadata:{name:'fast',annotations:{'storageclass.kubernetes.io/is-default-class':'true'}}}]};
const nodes=id=>({items:[{spec:{providerID:id}}]});
test('credential decoding preserves a multiline kubeconfig exactly',()=>{
  const original='apiVersion: v1\nclusters:\n  - name: cluster\n';
  assert.equal(kubeconfigText('base64:'+Buffer.from(original).toString('base64')),original);
  assert.equal(kubeconfigText(original),original);
  assert.throws(()=>kubeconfigText('__PWRD__'),{code:'KUBECONFIG'});
});

test('provider detection covers known IDs and uses generic for unknown or mixed providers',()=>{
  for(const [id,expected] of [['hcloud://42','hetzner'],['aws:///eu/test','aws'],['azure:///id','azure'],['gce://project/zone/a','gcp'],['openstack:///id','openstack'],['digitalocean://123','digitalocean'],['oci://id','oci'],['scaleway://id','scaleway'],['alicloud://id','alibaba'],['','generic']])assert.equal(provider(nodes(id)),expected);
  assert.equal(provider({items:[...nodes('aws:///a').items,...nodes('hcloud://b').items]}),'generic');
});
test('storage class selection rejects absent, ambiguous and nonexistent defaults',()=>{
  assert.equal(storageClass(classes,''),'fast');
  assert.throws(()=>storageClass({items:[]},''),{code:'STORAGE_CLASS'});
  assert.throws(()=>storageClass({items:[...classes.items,...classes.items]},''),{code:'STORAGE_CLASS'});
  assert.throws(()=>storageClass(classes,'missing'),{code:'STORAGE_CLASS'});
  assert.equal(storageClass(classes,'fast'),'fast');
});
test('legacy configuration cannot silently trigger the new deployment',()=>assert.throws(()=>config({...example,procedureVersion:undefined}),{code:'RECONFIGURE'}));
test('configuration rejects malformed host, tenant, annotations and injection strings',()=>{
  for(const bad of [{domainAddress:'https://example.com'},{tenantId:'../../escape'},{tenantRelease:'a;uname'},{emailAddress:'a@x.com,evil=1'},{lbAnnotations:'[]'},{timeoutSeconds:1},{provider:'shell'}])assert.throws(()=>config({...example,...bad}));
});
test('DNS selection distinguishes cluster provider from DNS provider',()=>{
  const c=config({...example,externalDns:true});
  assert.throws(()=>resolve(c,nodes('aws:///a'),classes,{}),{code:'DNS_PROVIDER'});
  assert.throws(()=>resolve(c,nodes('hcloud://a'),classes,{}),{code:'DNS_CREDENTIALS'});
  assert.equal(resolve({...c,dnsProvider:'ionos'},nodes('aws:///a'),classes,{dnsToken:'secret'}).actualDns,'ionos');
  const custom=resolve({...c,dnsProvider:'custom',dnsValues:{provider:{name:'cloudflare'}}},nodes('hcloud://a'),classes,{});
  assert.equal(custom.actualProvider,'hetzner');assert.equal(custom.profile,'generic');
});
test('generic networking removes all upstream Hetzner annotations; custom overrides survive Argo',()=>{
  const c=resolve(config({...example,provider:'aws',lbAnnotations:{'service.beta.kubernetes.io/aws-load-balancer-scheme':'internet-facing'}}),nodes('aws:///a'),classes,{});
  const patch=networkValues(c).esbTemplatePatch;
  assert.match(patch,/valuesObject/);assert.match(patch,/aws-load-balancer-scheme/);assert.match(patch,/network-zone\\":null/);
  const hetzner=resolve(config(example),nodes('hcloud://a'),classes,{});
  assert.doesNotMatch(networkValues(hetzner).esbTemplatePatch,/network-zone/);
});
test('custom DNS values are Go-template string data, not executable template input',()=>{
  const c=resolve(config({...example,externalDns:true,dnsProvider:'custom',dnsValues:{provider:{name:'cloudflare'},txtOwnerId:'{{ fail "unsafe" }}'}}),nodes('aws:///a'),classes,{dnsSecretData:'{"token":"test"}'});
  assert.match(networkValues(c).esbTemplatePatch,/valuesObject: \{\{ "\{/);
  assert.equal(c.dnsSecret.token,'test');
});
