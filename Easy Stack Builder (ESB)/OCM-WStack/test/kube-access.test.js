'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {preflight,argo,review,ARGO_ACCESS}=require('../lib/kube-access');
const username='system:serviceaccount:kube-system:cluster-admin';

function reviewer(decide=()=>true) {
  const requests=[],events=[];
  const r={env:{ESB_KUBE_USERNAME:username},emit:e=>events.push(e),json:async(command,args,options)=>{
    assert.equal(command,'kubectl');
    if(args.includes('whoami'))return {status:{userInfo:{username,groups:['system:authenticated']}}};
    assert.deepEqual(args,['create','--raw=/apis/authorization.k8s.io/v1/selfsubjectaccessreviews','-f','-','--request-timeout=15s']);
    const request=JSON.parse(options.input);requests.push(request);
    assert.equal(request.kind,'SelfSubjectAccessReview');assert.equal(request.apiVersion,'authorization.k8s.io/v1');
    assert.deepEqual(Object.keys(request.spec),['resourceAttributes']);
    return {status:{allowed:decide(request.spec.resourceAttributes)}};
  }};
  return {r,requests,events};
}

test('preflight reviews all API groups and exact Argo resources without discovery or CRDs',async()=>{
  const {r,requests,events}=reviewer();await preflight(r);
  assert.deepEqual(requests.map(x=>x.spec.resourceAttributes),[{group:'*',resource:'*',verb:'*'},...ARGO_ACCESS]);
  assert.equal(events.length,5);assert.ok(events.every(e=>e.allowed&&e.username===username));
});

test('broad access approval cannot hide an explicit applications.argoproj.io denial',async()=>{
  const {r,requests,events}=reviewer(a=>!(a.group==='argoproj.io'&&a.resource==='applications'&&a.verb==='list'));
  await assert.rejects(preflight(r),e=>e.code==='RBAC'&&e.message.includes(username)&&e.message.includes('applications.argoproj.io in namespace argocd')&&e.message.includes('No installation was started.'));
  assert.equal(requests.length,3);assert.equal(events.at(-1).allowed,false);
});

test('missing authorization decisions and explicitly denied responses cannot pass preflight',async()=>{
  for(const status of [{},{allowed:'true'},{allowed:true,denied:true}]) {
    const r={env:{},emit:()=>{},json:async()=>({status})};
    await assert.rejects(review(r,{group:'argoproj.io',resource:'applications',verb:'list',namespace:'argocd'}),e=>['RBAC','RBAC_RESPONSE'].includes(e.code));
  }
});

test('review connection failure is propagated without permission writes or retries',async()=>{
  let calls=0;const error=Object.assign(new Error('connection failed'),{code:'COMMAND_FAILED'});
  const r={env:{},emit:()=>{},json:async()=>{calls++;throw error;}};
  await assert.rejects(preflight(r),e=>e===error);assert.equal(calls,1);
});

test('post-bootstrap guard refuses an identity change before reviewing permissions',async()=>{
  const {r,requests}=reviewer();r.env.ESB_KUBE_USERNAME='expected-admin';
  await assert.rejects(argo(r),{code:'KUBE_IDENTITY_CHANGED'});assert.equal(requests.length,0);
});

test('post-bootstrap guard checks the same identity and distinguishes retained resources',async()=>{
  const {r,requests}=reviewer(a=>a.verb!=='list');
  await assert.rejects(argo(r),e=>e.code==='RBAC'&&e.message.includes('Installed resources are retained.'));
  assert.equal(requests.length,2);
});

test('operation rejects denied Argo access before source checkout, lease, marker or Helm writes',async()=>{
  const calls=[];let sourceCalls=0;
  const {operation}=require('../lib/install');
  const options={checkoutSource:async()=>{sourceCalls++;throw Error('must not checkout');},runnerFactory:({env,emit,secrets})=>({env,emit,secrets,run:async(command,args)=>{
    calls.push({command,args});
    if(args[0]==='-c'&&args[1]==='command -v "$1"')return {stdout:'/usr/local/bin/'+args.at(-1),stderr:'',code:0};
    return {stdout:'',stderr:'',code:0};
  },json:async(command,args,opts)=>{
    calls.push({command,args});
    if(args.includes('view'))return {'current-context':'uploaded',contexts:[{name:'uploaded',context:{user:'admin',cluster:'cluster'}}],users:[{name:'admin',user:{token:'test-only'}}],clusters:[{name:'cluster',cluster:{server:'https://cluster.example'}}]};
    if(args.includes('whoami'))return {status:{userInfo:{username}}};
    if(args.includes('--raw=/apis/authorization.k8s.io/v1/selfsubjectaccessreviews')) {
      const a=JSON.parse(opts.input).spec.resourceAttributes;
      return {status:{allowed:!(a.group==='argoproj.io'&&a.verb==='list')}};
    }
    throw Error('Unexpected API call: '+args.join(' '));
  }})};
  await assert.rejects(operation('deploy',{procedureVersion:12,domain:'example.com'},{kubeconfig:'test uploaded kubeconfig'},options),{code:'RBAC'});
  assert.equal(sourceCalls,0);
  assert.ok(!calls.some(c=>c.command==='helm'||c.args.includes('apply')||c.args.includes('replace')||c.args.includes('lease')));
});
