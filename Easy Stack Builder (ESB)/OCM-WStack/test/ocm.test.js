'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const ocm=require('../lib/ocm');
test('verification signing key uses the exact service decoder contract and signs verifiable IDs',()=>{
  const pem=ocm.signingKey(),key=ocm.validateKey(pem);
  assert.match(pem,/^-----BEGIN EC PRIVATE KEY-----/);
  assert.equal(key.asymmetricKeyDetails.namedCurve,'prime256v1');
  const id=Buffer.from('tenant-company');
  const sig=crypto.sign('sha256',id,key);
  assert.ok(crypto.verify('sha256',id,crypto.createPublicKey(key),sig));
  assert.ok(!crypto.verify('sha256',Buffer.from('another-tenant'),crypto.createPublicKey(key),sig));
  assert.equal(ocm.validateKey(Buffer.from(pem).toString('base64')).asymmetricKeyType,'ec');
  assert.throws(()=>ocm.validateKey(key.export({format:'pem',type:'sec1'}).toString()),{code:'SIGNING_KEY'});
  assert.throws(()=>ocm.validateKey(key.export({format:'pem',type:'pkcs8'}).toString()),{code:'SIGNING_KEY'});
});
test('existing signing material is retained and passwords are referenced through ESO',async()=>{
  const key=ocm.signingKey(),calls=[];
  const r={secrets:[],emit(){},json:async(cmd,args)=>args.includes('secret')?{data:{'signing-key':Buffer.from(key).toString('base64')}}:null,
    run:async(cmd,args,opts)=>{calls.push({args,doc:opts?.input?JSON.parse(opts.input):null});return {stdout:''};}};
  await ocm.prerequisites(r,60);await ocm.prerequisites(r,60);
  assert.ok(!calls.some(x=>x.args.includes('create')));
  const eso=calls.find(x=>x.args.includes('apply')).doc;
  assert.equal(eso.spec.secretStoreRef.kind,'ClusterSecretStore');
  assert.deepEqual(eso.spec.data,[{secretKey:'cassandra-password',remoteRef:{key:'cassandra/cassandra',property:'password'}}]);
  assert.ok(!JSON.stringify(calls).includes(key));
});
test('incompatible existing signing material stops before writes and is never replaced',async()=>{
  let writes=0;
  const r={secrets:[],json:async()=>({data:{'signing-key':Buffer.from('wrong-key').toString('base64')}}),run:async()=>writes++,emit(){}};
  await assert.rejects(ocm.prerequisites(r,60),{code:'SIGNING_KEY'});assert.equal(writes,0);
});
test('foreign Cassandra ExternalSecret is retained rather than overwritten',async()=>{
  let writes=0;
  const key=ocm.signingKey();
  const r={secrets:[],json:async(cmd,args)=>args.includes('secret')?{data:{'signing-key':Buffer.from(key).toString('base64')}}:{metadata:{labels:{}}},run:async()=>writes++,emit(){}};
  await assert.rejects(ocm.prerequisites(r,60),{code:'OWNERSHIP'});assert.equal(writes,0);
});
test('policy image preflight requires HEAD and a real image manifest, not an OCI Helm artifact',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ocm-image-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const calls=[];let media='application/vnd.cncf.helm.config.v1+json';
  const r={redact:String,emit(){},run:async(cmd,args)=>{calls.push(args);await fs.writeFile(args[args.indexOf('--output')+1],args.includes('--head')?'HTTP/1.1 200 OK':JSON.stringify({schemaVersion:2,config:{mediaType:media}}));}};
  await assert.rejects(ocm.imagePreflight(r,dir),{code:'POLICY_IMAGE'});
  media='application/vnd.oci.image.config.v1+json';await ocm.imagePreflight(r,dir);
  assert.ok(calls[0].includes('--head'));assert.ok(!calls[1].includes('--head'));
});
test('semantic validation rejects the observed policy root image and missing-pull-secret configuration',()=>{
  const workload={kind:'Deployment',spec:{template:{spec:{containers:[{name:'policy',image:ocm.POLICY_IMAGE,ports:[{name:'http',containerPort:8080}],env:[{name:'NATS_ADDR',value:'nats://nats.infrastructure.svc.cluster.local:4222'}]}]}}}};
  const service={kind:'Service',metadata:{name:'policy'},spec:{ports:[{port:8080,targetPort:8080}]}};
  ocm.validateManifests({workload,service},ocm.POLICY);
  workload.spec.template.spec.imagePullSecrets=[{name:'deployment-key-light'}];
  assert.throws(()=>ocm.validateManifests({workload,service},ocm.POLICY),{code:'OCM_VALUES'});
  delete workload.spec.template.spec.imagePullSecrets;
  workload.spec.template.spec.containers[0].env[0].value='nats.NAMESPACE.svc.cluster.local';
  assert.throws(()=>ocm.validateManifests({workload,service},ocm.POLICY),{code:'OCM_VALUES'});
  workload.spec.template.spec.containers[0].env[0].value='nats://nats.infrastructure.svc.cluster.local:4222';
  service.spec.ports[0].targetPort=8222;
  assert.throws(()=>ocm.validateManifests({workload,service},ocm.POLICY),{code:'OCM_VALUES'});
});
