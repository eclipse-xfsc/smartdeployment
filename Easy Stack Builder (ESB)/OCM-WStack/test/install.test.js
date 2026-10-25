'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {operation,lease}=require('../lib/install');
const {Runner}=require('../lib/runner');
const {adapt}=require('../lib/adapt');
const example=require('../examples/deployment.json');
async function setup(t,{failRelease='',namespaces=['kube-system']}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-integration-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const state=path.join(dir,'state.json'),calls=path.join(dir,'calls.jsonl');
  await fs.writeFile(state,JSON.stringify({namespaces,objects:{},appsets:[]}));await fs.writeFile(calls,'');
  for(const name of ['kubectl','helm','git','curl']){await fs.copyFile(path.join(__dirname,'fake-cli.cjs'),path.join(dir,name));await fs.chmod(path.join(dir,name),0o700);}
  const events=[];
  const options={emit:e=>events.push(e),runnerFactory:args=>new Runner({...args,env:{...args.env,PATH:`${dir}:${process.env.PATH}`,ESB_TEST_STATE:state,ESB_TEST_CALLS:calls,ESB_TEST_FAIL_RELEASE:failRelease,ESB_TEST_SOURCE:path.join(__dirname,'fixtures/upstream')}}),checkoutSource:async(r,workspace)=>{const source=path.join(workspace,'deployment');await fs.cp(path.join(__dirname,'fixtures/upstream'),source,{recursive:true});await adapt(source);return source;}};
  const originalFetch=global.fetch;
  global.fetch=async url=>new Response(JSON.stringify(url.endsWith('/openid-credential-issuer')?{credential_issuer:'https://demo-tenant.example.com',credential_endpoint:'https://demo-tenant.example.com/api/credential',credential_configurations_supported:{SDJWTCredential:{}}}:url.endsWith('/did.json')?{id:'did:web:demo-tenant.example.com',verificationMethod:[{id:'key'}]}:{keys:[{kid:'key'}]}),{status:200,headers:{'content-type':'application/json'}});
  t.after(()=>{global.fetch=originalFetch;});
  return {dir,events,options,readCalls:async()=> (await fs.readFile(calls,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)),readState:async()=>JSON.parse(await fs.readFile(state,'utf8'))};
}
test('executes real official entrypoint once, in order, and installs upstream tenant after healthy appsets',async t=>{
  const h=await setup(t);const report=await operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options);
  assert.equal(report.status,'ready');assert.equal(report.credentialLifecycle,'not-tested');
  const calls=await h.readCalls();const upgrades=calls.filter(x=>x.command==='helm'&&x.args[0]==='upgrade');
  const firstMutation=calls.findIndex(x=>(x.command==='helm'&&x.args[0]==='upgrade')||(x.command==='kubectl'&&x.args.some(a=>['create','replace','apply'].includes(a))));
  const lastRender=calls.findLastIndex(x=>x.command==='helm'&&x.args[0]==='template');
  assert.ok(lastRender<firstMutation,'all chart renders must precede the first cluster write');
  assert.ok(!calls.slice(firstMutation).some(x=>x.command==='helm'&&x.args[0]==='dependency'),'do not resolve new chart dependencies during installation');
  const names=upgrades.map(x=>x.args[2]==='--timeout'?x.args[x.args.indexOf('-n')+2]:x.args[2]);
  assert.deepEqual(names,['observability','openbao','eso','kyverno','infrastructure-namespace','kubernetes-operator','storage','network','core','ocm-wstack-namespace','ocm-wstack','demotenant']);
  assert.ok(upgrades.every(x=>x.cwd.endsWith('/deployment')));
  const readyIndex=calls.findIndex(x=>x.command==='kubectl'&&x.args.includes('wait')&&x.args.includes('pod/openbao-0'));
  assert.ok(readyIndex>0);assert.ok(calls[readyIndex].args.includes('--for=condition=Ready'));
  assert.ok(readyIndex<calls.findIndex(x=>x.command==='helm'&&x.args[0]==='upgrade'&&x.args.includes('eso')));
  const network=upgrades[names.indexOf('network')];assert.ok(network.args.includes('excludes[1]=INFRA/network/external-dns'));assert.match(network.network.esbTemplatePatch,/valuesObject/);
  assert.equal(calls.filter(x=>x.command==='kubectl'&&x.args.some(a=>a.includes('argo-install.yaml'))).length,1);
  assert.equal(calls.find(x=>x.argoRedisImage)?.argoRedisImage,'docker.io/library/redis:8.2.3-alpine');
  assert.ok(calls.some(x=>x.args.includes('deployment/argocd-dex-server')));
  assert.ok(calls.some(x=>x.args.includes('deployment/argocd-redis')));
  assert.equal((await h.readState()).objects['kube-system/configmap/esb-ocmwstack-v12'].data.bootstrapComplete,'true');
  const before=upgrades.length;
  await operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options);
  const after=(await h.readCalls()).filter(x=>x.command==='helm'&&x.args[0]==='upgrade');assert.equal(after.length,before+1);assert.equal(after.at(-1).args[2],'demotenant');
});
test('upstream Helm failure stops before network/OCM/tenant, retains progress and permits a matching resume',async t=>{
  const h=await setup(t,{failRelease:'storage'});
  await assert.rejects(operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options),{code:'COMMAND_FAILED'});
  const calls=await h.readCalls();assert.ok(!calls.some(x=>x.command==='helm'&&x.args[0]==='upgrade'&&x.args.includes('network')));assert.ok(!calls.some(x=>x.command==='helm'&&x.args[0]==='upgrade'&&x.args.includes('demotenant')));
  const marker=(await h.readState()).objects['kube-system/configmap/esb-ocmwstack-v12'];assert.equal(marker.data.state,'failed');assert.notEqual(marker.data.bootstrapComplete,'true');
  const factory=h.options.runnerFactory;h.options.runnerFactory=opts=>{const r=factory(opts);delete r.env.ESB_TEST_FAIL_RELEASE;return r;};
  assert.equal((await operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options)).status,'ready');
});
test('existing unrelated namespaces are refused without any Helm deployment',async t=>{
  const h=await setup(t,{namespaces:['kube-system','argocd']});
  await assert.rejects(operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options),{code:'NOT_FRESH'});
  assert.ok(!(await h.readCalls()).some(x=>x.command==='helm'&&x.args[0]==='upgrade'));
});
test('DNS credentials are passed through a private manifest, not script arguments or events',async t=>{
  const h=await setup(t);await operation('deploy',{...example,externalDns:true,dnsProvider:'ionos'},{kubeconfig:'mock-cluster-config',dnsToken:'very-private-dns-token'},h.options);
  const calls=await h.readCalls();assert.ok(!calls.some(x=>x.args.some(a=>a.includes('very-private-dns-token'))));assert.ok(!JSON.stringify(h.events).includes('very-private-dns-token'));
  const secretApply=calls.find(x=>x.command==='kubectl'&&x.args[0]==='apply'&&x.args.some(a=>a.endsWith('/dns-secret.json')));assert.equal(secretApply.dns.stringData.token,'very-private-dns-token');
  await assert.rejects(fs.stat(secretApply.args.at(-1)),{code:'ENOENT'});
});
test('teardown needs an explicit matching confirmation and retains stack and namespaces',async t=>{
  const h=await setup(t);await operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options);
  await assert.rejects(operation('teardown',example,{kubeconfig:'mock-cluster-config'},h.options),{code:'CONFIRM'});
  const result=await operation('teardown',{...example,confirm:'REMOVE TENANT demotenant'},{kubeconfig:'mock-cluster-config'},h.options);assert.equal(result.status,'tenant-removed');
  const calls=await h.readCalls();assert.equal(calls.filter(x=>x.command==='helm'&&x.args[0]==='uninstall').length,1);assert.ok(!calls.some(x=>x.command==='kubectl'&&x.args.includes('delete')));
});
test('a live cluster lease prevents a second owner from running installation',async t=>{
  const h=await setup(t);
  const r=h.options.runnerFactory({env:process.env,emit:()=>{}});
  const first=await lease(r,'owner-one');
  await assert.rejects(lease(r,'owner-two'),{code:'BUSY'});
  await first.release();
  const next=await lease(r,'owner-two');await next.release();
});
test('an unready OnDelete OpenBao pod stops bootstrap; retry succeeds when the pod is Ready',async t=>{
  const h=await setup(t);
  const normal=h.options.runnerFactory;
  h.options.runnerFactory=opts=>{const r=normal(opts);r.env.ESB_TEST_OPENBAO_UNREADY='true';return r;};
  await assert.rejects(operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options),e=>e.code==='COMMAND_FAILED'&&e.message.includes('pods/openbao-0'));
  const calls=await h.readCalls();
  assert.ok(!calls.some(x=>x.command==='helm'&&x.args[0]==='upgrade'&&x.args.includes('eso')));
  assert.equal((await h.readState()).objects['kube-system/configmap/esb-ocmwstack-v12'].data.state,'failed');
  h.options.runnerFactory=normal;
  assert.equal((await operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options)).status,'ready');
});
test('a late chart template error is detected before any cluster mutation, including ownership and lease writes',async t=>{
  const h=await setup(t);const factory=h.options.runnerFactory;
  h.options.runnerFactory=opts=>{const r=factory(opts);r.env.ESB_TEST_BAD_CHART='storage-service';return r;};
  await assert.rejects(operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options),e=>e.code==='CHART_PREFLIGHT'&&e.message.includes('OCM W-Stack/Storage Service'));
  const calls=await h.readCalls();
  assert.ok(!calls.some(x=>x.command==='helm'&&['upgrade','install','uninstall'].includes(x.args[0])));
  assert.ok(!calls.some(x=>x.command==='kubectl'&&x.args.some(a=>['create','replace','apply','patch','delete'].includes(a))));
  assert.deepEqual((await h.readState()).objects,{});
  assert.ok(calls.some(x=>x.command==='helm'&&x.args[0]==='template'&&x.args[1]==='demotenant'),'check remaining charts after one fails');
});
test('preflight checks the complete selection without modifying the cluster',async t=>{
  const h=await setup(t);const report=await operation('preflight',example,{kubeconfig:'mock-cluster-config'},h.options);
  assert.equal(report.status,'charts-validated');assert.equal(report.liveDeploymentTested,false);
  assert.deepEqual(report.applicationCounts,{'storage':5,'network':3,'core':2,'ocm-wstack':12});
  assert.equal(report.charts.length,34);
  const calls=await h.readCalls();
  assert.ok(!calls.some(x=>x.command==='helm'&&x.args[0]==='upgrade'));
  assert.deepEqual((await h.readState()).objects,{});
});

test('real bootstrap helper recovers one Kyverno POST EOF without replaying earlier releases',async t=>{
  const h=await setup(t);const factory=h.options.runnerFactory;
  h.options.runnerFactory=opts=>{const r=factory(opts);r.env.ESB_TEST_EOF_RELEASE='kyverno';return r;};
  assert.equal((await operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options)).status,'ready');
  const calls=await h.readCalls(),upgrades=calls.filter(c=>c.command==='helm'&&c.args[0]==='upgrade');
  const state=await h.readState();assert.equal(state.attempts['security/kyverno'],2);assert.equal(state.attempts['observability/observability'],1);assert.equal(state.attempts['security/openbao'],1);
  assert.ok(upgrades.every(c=>c.qps==='5'&&c.burst==='10'));
  assert.ok(!calls.some(c=>c.args.includes('delete')||c.args.includes('rollback')||c.args.includes('--force')||c.args.includes('--atomic')));
  assert.ok(h.events.some(e=>e.type==='log'&&e.message.includes('"type":"retry"')));
});
test('real bootstrap helper preserves a pending release after EOF and stops later stages',async t=>{
  const h=await setup(t);const factory=h.options.runnerFactory;
  h.options.runnerFactory=opts=>{const r=factory(opts);r.env.ESB_TEST_EOF_RELEASE='kyverno';r.env.ESB_TEST_PENDING='true';return r;};
  await assert.rejects(operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options),{code:'HELM_PENDING'});
  const state=await h.readState();assert.equal(state.attempts['security/kyverno'],1);assert.equal(state.releases['security/kyverno'],'pending-install');assert.equal(state.attempts['infrastructure/storage'],undefined);
  assert.equal(state.objects['kube-system/configmap/esb-ocmwstack-v12'].data.lastErrorCode,'HELM_PENDING');
});
test('diagnose-api uses the operation kubeconfig without chart downloads or mutation',async t=>{
  const h=await setup(t);const result=await operation('diagnose-api',example,{kubeconfig:'mock-cluster-config'},h.options);
  assert.equal(result.status,'api-reachable');const calls=await h.readCalls();assert.equal(calls.filter(c=>c.args.includes('--raw=/readyz')).length,5);
  assert.ok(!calls.some(c=>c.command==='helm'&&['template','upgrade'].includes(c.args[0])));
  assert.deepEqual((await h.readState()).objects,{});
});

test('real bootstrap recovers an Argo Application read EOF without replaying Storage',async t=>{
  const h=await setup(t);const factory=h.options.runnerFactory;
  h.options.runnerFactory=opts=>{const r=factory(opts);r.env.ESB_TEST_ARGO_READ_EOF='true';return r;};
  assert.equal((await operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options)).status,'ready');
  const state=await h.readState();assert.equal(state.attempts['infrastructure/storage'],1);
  const calls=await h.readCalls();
  const crdIndex=calls.findIndex(c=>c.args.includes('--raw=/apis/apiextensions.k8s.io/v1/customresourcedefinitions/applications.argoproj.io'));
  const storageIndex=calls.findIndex(c=>c.command==='helm'&&c.args[0]==='upgrade'&&c.args.includes('storage'));
  assert.ok(crdIndex>0&&crdIndex<storageIndex);
  assert.ok(h.events.some(e=>e.type==='log'&&e.message.includes('api-read-retry')));
});

test('unready Argo Redis stops before infrastructure and reports ImagePullBackOff',async t=>{
 const h=await setup(t);const factory=h.options.runnerFactory;
 h.options.runnerFactory=opts=>{const r=factory(opts);r.env.ESB_TEST_REDIS_UNREADY='true';return r;};
 await assert.rejects(operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options),e=>e.message.includes('ImagePullBackOff'));
 assert.equal((await h.readState()).attempts['security/infrastructure-namespace'],undefined);
});
test('duplicate Grafana defaults are rejected before any cluster mutation',async t=>{
 const h=await setup(t);const factory=h.options.runnerFactory;
 h.options.runnerFactory=opts=>{const r=factory(opts);r.env.ESB_TEST_BAD_DATASOURCES='true';return r;};
 await assert.rejects(operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options),e=>e.code==='CHART_PREFLIGHT'&&e.message.includes('More than one'));
 assert.deepEqual((await h.readState()).objects,{});
});

test('all bootstrap and helper API commands use the exact upload and context despite inherited Helm credentials',async t=>{
 const h=await setup(t);const factory=h.options.runnerFactory;
 h.options.runnerFactory=opts=>{const r=factory(opts);r.env.HELM_KUBETOKEN='ambient-token';r.env.HELM_KUBECONTEXT='ambient-context';return r;};
 const upload='mock-cluster-config';await operation('deploy',example,{kubeconfig:upload},h.options);
 const hash=require('node:crypto').createHash('sha256').update(upload).digest('hex');
 const calls=(await h.readCalls()).filter(c=>['kubectl','helm'].includes(c.command));
 assert.ok(calls.length>100);
 assert.ok(calls.every(c=>c.explicitConfig&&c.kubeconfigSha256===hash&&!c.helmTokenOverride));
 assert.ok(calls.filter(c=>!c.args.includes('view')).every(c=>c.explicitContext==='uploaded-context'));
 assert.ok(h.events.some(e=>e.type==='kubeconfig-identity'&&e.username==='uploaded-admin'));
 assert.ok(!JSON.stringify(h.events).includes('ambient-token'));
});
test('diagnose-auth identifies the uploaded context and actual user without writes',async t=>{
 const h=await setup(t);const report=await operation('diagnose-auth',example,{kubeconfig:'mock-cluster-config'},h.options);
 assert.equal(report.source,'editor-upload');assert.equal(report.context,'uploaded-context');assert.equal(report.identity.username,'uploaded-admin');
 assert.deepEqual((await h.readState()).objects,{});
});
test('missing uploaded credentials cannot use ambient service account credentials',async t=>{
 const h=await setup(t);const factory=h.options.runnerFactory;
 h.options.runnerFactory=opts=>{const r=factory(opts);r.env.ESB_TEST_EMPTY_AUTH='true';return r;};
 await assert.rejects(operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options),{code:'KUBECONFIG_AUTH'});
 assert.deepEqual((await h.readState()).objects,{});
});
test('Argo authorization denial is detected before cluster writes without creating RBAC',async t=>{
 const h=await setup(t);const factory=h.options.runnerFactory;
 h.options.runnerFactory=opts=>{const r=factory(opts);r.env.ESB_TEST_ARGO_FORBIDDEN='true';return r;};
 await assert.rejects(operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options),{code:'RBAC'});
 assert.deepEqual((await h.readState()).objects,{});
 assert.ok(!(await h.readCalls()).some(c=>c.args.includes('apply')||c.args.includes('create')));
});

test('unresolvable policy image fails before any cluster writes',async t=>{
 const h=await setup(t);const factory=h.options.runnerFactory;
 h.options.runnerFactory=opts=>{const r=factory(opts);r.env.ESB_TEST_BAD_POLICY_IMAGE='true';return r;};
 await assert.rejects(operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options),{code:'POLICY_IMAGE'});
 assert.deepEqual((await h.readState()).objects,{});
});
test('rendered unresolved OCM placeholders fail before cluster writes',async t=>{
 const h=await setup(t);const factory=h.options.runnerFactory;
 h.options.runnerFactory=opts=>{const r=factory(opts);r.env.ESB_TEST_BAD_OCM_VALUES='true';return r;};
 await assert.rejects(operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options),{code:'CHART_PREFLIGHT'});
 assert.deepEqual((await h.readState()).objects,{});
});
test('repair reconciles OCM and tenant only, retains signing key and preserves kubeconfig pinning',async t=>{
 const h=await setup(t);await operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options);
 const interrupted=await h.readState();
 interrupted.objects['kube-system/configmap/esb-ocmwstack-v12'].data.bootstrapComplete='false';
 interrupted.objects['kube-system/configmap/esb-ocmwstack-v12'].data.state='failed';
 await fs.writeFile(path.join(h.dir,'state.json'),JSON.stringify(interrupted));
 const key=(await h.readState()).objects['ocm-wstack/secret/signing'].data['signing-key'];
 const before=(await h.readCalls()).length;
 const report=await operation('repair-ocm',example,{kubeconfig:'mock-cluster-config'},h.options);
 assert.equal(report.status,'ready');
 const calls=(await h.readCalls()).slice(before);
 assert.deepEqual(calls.filter(c=>c.command==='helm'&&c.args[0]==='upgrade').map(c=>c.args[2]),['ocm-wstack','demotenant']);
 assert.equal((await h.readState()).objects['ocm-wstack/secret/signing'].data['signing-key'],key);
 assert.ok(calls.filter(c=>['helm','kubectl'].includes(c.command)).every(c=>c.explicitConfig));
 const upgrade=calls.find(c=>c.command==='helm'&&c.args[0]==='upgrade'&&c.args[2]==='ocm-wstack');
 assert.match(upgrade.ocm.esbTemplatePatch,/tsa\/policy/);
 assert.ok(!JSON.stringify(h.events).includes(key));
});
test('repair refuses an unowned cluster and never creates an installation marker',async t=>{
 const h=await setup(t);await assert.rejects(operation('repair-ocm',example,{kubeconfig:'mock-cluster-config'},h.options),{code:'OWNERSHIP'});
 assert.ok(!(await h.readState()).objects['kube-system/configmap/esb-ocmwstack-v12']);
});
test('repair refuses changed original configuration before any writes',async t=>{
 const h=await setup(t);await operation('deploy',example,{kubeconfig:'mock-cluster-config'},h.options);
 const before=(await h.readCalls()).length;
 await assert.rejects(operation('repair-ocm',{...example,tenantId:'another-tenant'},{kubeconfig:'mock-cluster-config'},h.options),{code:'OWNERSHIP'});
 const calls=(await h.readCalls()).slice(before);
 assert.ok(!calls.some(c=>c.command==='kubectl'&&c.args.some(a=>['create','replace','apply','patch','delete'].includes(a))));
});
