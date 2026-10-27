'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const https=require('node:https');
const {execFileSync}=require('node:child_process');
const {jq,workspace,bashAsync}=require('./helpers.cjs');

function dns(port=8053) {
  return {
    service:{metadata:{name:'kube-dns',namespace:'kube-system'},spec:{selector:{'k8s-app':'kube-dns'},ports:[
      {name:'dns',port:53,protocol:'UDP'}, {name:'dns-tcp',port:53,protocol:'TCP'},
      {name:'metrics',port:9153,protocol:'TCP'},
    ]}},
    slices:{items:[{metadata:{namespace:'kube-system',labels:{'kubernetes.io/service-name':'kube-dns'}},
      ports:[{name:'dns',port,protocol:'UDP'},{name:'dns-tcp',port,protocol:'TCP'},{name:'metrics',port:9153,protocol:'TCP'}],
      endpoints:[{conditions:{ready:true}}]}]},
  };
}

test('guard DNS rules follow standard and Gardener backend ports and exclude metrics',()=>{
  for(const port of [53,8053]) {
    const f=dns(port), rules=jq('guard_dns_egress($slices)',f.service,{slices:f.slices});
    assert.equal(rules.length,1);
    assert.deepEqual(rules[0].to,[{namespaceSelector:{matchLabels:{'kubernetes.io/metadata.name':'kube-system'}},podSelector:{matchLabels:{'k8s-app':'kube-dns'}}}]);
    assert.deepEqual(rules[0].ports,[{port,protocol:'TCP'},{port,protocol:'UDP'}]);
  }
});

test('guard DNS discovery rejects unrelated slices, unavailable backends and invalid ports',()=>{
  for(const mutate of [
    f=>{f.slices.items[0].metadata.namespace='other';},
    f=>{f.slices.items[0].metadata.labels['kubernetes.io/service-name']='other';},
    f=>{f.slices.items[0].endpoints[0].conditions.ready=false;},
    f=>{f.slices.items[0].endpoints[0].conditions.terminating=true;},
    f=>{f.slices.items[0].ports[0].port=70000;},
    f=>{f.slices.items[0].ports[0].name='unrelated';},
    f=>{f.service.spec.selector={};},
  ]) {
    const f=dns();mutate(f);
    assert.throws(()=>jq('guard_dns_egress($slices)',f.service,{slices:f.slices}),/GUARD_DNS_/);
  }
});

test('guard reaches the selected API address with verified TLS despite an injected external hostname',async t=>{
  const dir=workspace(t,{'account/token':'fixture-token'});
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
    '-subj','/CN=kubernetes.default.svc','-addext','subjectAltName=DNS:kubernetes.default.svc',
    '-keyout',dir+'/server.key','-out',dir+'/account/ca.crt'],{stdio:'ignore'});
  let requests=0;
  const server=https.createServer({key:fs.readFileSync(dir+'/server.key'),cert:fs.readFileSync(dir+'/account/ca.crt')},(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-token');
    assert.equal(req.url,'/api/v1/namespaces/ocm-wstack/pods');
    requests++;res.setHeader('Content-Type','application/json');res.end('{"items":[]}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {result}=bashAsync(dir,`
source "$DEPLOYMENT/reconcile.sh"
STATE_DIR="$WORKDIR"
API_ACCOUNT="$WORKDIR/account"
api_request GET /api/v1/namespaces/ocm-wstack/pods "$WORKDIR/response.json"
`,{KUBERNETES_SERVICE_HOST:'injected.invalid',OCM_GUARD_API_ADDRESS:'127.0.0.1',
    OCM_GUARD_API_PORT:String(server.address().port),NO_PROXY:'*',no_proxy:'*'});
  const r=await result;assert.equal(r.status,0,r.stderr);
  assert.equal(requests,1);
  assert.deepEqual(JSON.parse(fs.readFileSync(dir+'/response.json')),{items:[]});
  assert.ok(!r.stdout.includes('fixture-token'));
});

test('runtime DNS fallback retains default policy on standard or unsupported discovery',()=>{
  for(const port of [53,8053,1053]) {
    const f=dns(port),rules=jq('runtime_dns_fallback($slices)',f.service,{slices:f.slices});
    assert.deepEqual(rules,port===53?[]:jq('guard_dns_egress($slices)',f.service,{slices:f.slices}));
  }
  for(const change of [f=>f.service.spec.selector={},f=>f.slices.items=[],f=>f.slices.items[0].ports[0].port=70000,f=>f.slices.items[0].metadata.namespace='other']) {
    const f=dns();change(f);assert.deepEqual(jq('runtime_dns_fallback($slices)',f.service,{slices:f.slices}),[]);
  }
});

test('DNS discovery accepts IONOS coredns and Gardener kube-dns without adding unrelated ports',t=>{
 const {bash}=require('./helpers.cjs');
 for(const [name,port] of [['coredns',53],['kube-dns',8053],['dns-custom',1053]]) {
  const f=dns(port); f.service.metadata.name=name;
  f.slices.items[0].metadata.labels['kubernetes.io/service-name']=name;
  const dir=workspace(t,{'services.json':{items:[f.service,{metadata:{name:'monitoring-coredns'},spec:{ports:[{port:9153,protocol:'TCP'}]}}]},'slices.json':f.slices});
  const result=bash(dir,`
kube_json() {
  if [[ "$*" == *endpointslices* ]]; then cp "$WORKDIR/slices.json" "$1";
  else cp "$WORKDIR/services.json" "$1"; fi
}
runtime_dns_fallback "$WORKDIR/rules.json"
cat "$WORKDIR/rules.json"
`);
  assert.equal(result.status,0,result.stderr);
  const rules=JSON.parse(result.stdout);assert.equal(rules.length,port===53?0:1);
  if(rules.length) assert.deepEqual(rules[0].ports,[{port,protocol:'TCP'},{port,protocol:'UDP'}]);
 }
});

test('DNS discovery waits for ready backends and excludes foreign EndpointSlices',t=>{
 const {bash}=require('./helpers.cjs'),f=dns(8053);
 const dir=workspace(t,{'services.json':{items:[f.service]},'slices.json':f.slices});
 const result=bash(dir,`
sleep() { SECONDS=$((SECONDS+$1)); }
kube_json() {
 if [[ "$*" != *endpointslices* ]]; then cp "$WORKDIR/services.json" "$1"; return; fi
 if [[ ! -f $WORKDIR/seen ]]; then printf '{"items":[]}' >"$1"; touch "$WORKDIR/seen";
 else cp "$WORKDIR/slices.json" "$1"; fi
}
discover_dns "$WORKDIR/rules.json"
cat "$WORKDIR/rules.json"
`);
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout)[0].ports[0].port,8053);
});
