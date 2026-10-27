'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { workspace, bash } = require('./helpers.cjs');

const labels = {
  'gateway.envoyproxy.io/owning-gateway-name': 'envoy-gateway',
  'gateway.envoyproxy.io/owning-gateway-namespace': 'infrastructure',
};
function object(kind, policy = 'Local') {
  return { kind: kind === 'service' ? 'Service' : 'EnvoyProxy',
    metadata: { name: kind === 'service' ? 'envoy-service' : 'envoy', namespace: 'infrastructure',
      uid: kind + '-uid', resourceVersion: '1', labels: { ...labels } },
    spec: kind === 'service' ? { type: 'LoadBalancer', clusterIP: '10.0.0.5', externalTrafficPolicy: policy,
      ports: [{ port: 80, targetPort: 8080 }], selector: { app: 'envoy' } } :
      { provider: { kubernetes: { envoyService: { externalTrafficPolicy: policy } } } },
    status: { loadBalancer: { ingress: [{ ip: '192.0.2.5' }] } } };
}

// A disk-backed server permits writes between a read and its conditional patch.
// It records each patch so tests can assert that a rejected patch is rebuilt.
function scenario(t, { mode = 'normal', kind = 'service', policy = 'Local', desired = 'Cluster', grace = 0,
  budget = 60, lease = true, full = false, foreign = false } = {}) {
  const service = object('service', policy);
  if (foreign) service.metadata.labels['gateway.envoyproxy.io/owning-gateway-name'] = 'other';
  const dir = workspace(t, { 'config.json': { externalTrafficPolicy: desired, externalDns: false, tenantHost: 'tenant.example.invalid' },
    'server.json': { service, envoyproxy: object('envoyproxy', policy), reads: 0, patches: 0 },
    'calls.json': [] });
  fs.writeFileSync(dir + '/server.cjs', `
const fs=require('fs'),root=process.env.WORKDIR,mode=process.env.MODE;
const [output,...args]=process.argv.slice(2);
const read=n=>JSON.parse(fs.readFileSync(root+'/'+n));
const write=(n,v)=>fs.writeFileSync(root+'/'+n,JSON.stringify(v));
const s=read('server.json'),calls=read('calls.json');
const verb=args.includes('patch')?'patch':'get',at=args.indexOf(verb),kind=args[at+1];
const setPolicy=o=>{ if(o.kind==='Service')o.spec.externalTrafficPolicy=process.env.DESIRED;
 else o.spec.provider.kubernetes.envoyService.externalTrafficPolicy=process.env.DESIRED; };
const bump=o=>o.metadata.resourceVersion=String(Number(o.metadata.resourceVersion)+1);
let error='';
if(verb==='get') {
 s.reads++;
 if(mode==='controller' && s.reads>=3){setPolicy(s.service);bump(s.service);}
 if(mode==='foreign-after' && s.patches>0)s.service.metadata.labels['gateway.envoyproxy.io/owning-gateway-name']='other';
 const result=mode==='missing'?null:kind==='services'?{items:[s.service]}:s[kind];
 fs.writeFileSync(output,result===null?'':JSON.stringify(result));
 calls.push({verb,kind});
} else {
 s.patches++;
 const patch=readPath(args[args.indexOf('--patch-file')+1]);
 calls.push({verb,kind,patch,args});
 const o=s[kind];
 if(mode==='conflict' && s.patches===1 || mode==='conflict-always' || mode==='foreign-after')bump(o);
 if(mode==='recreated' && s.patches===1)o.metadata.uid='replacement-uid';
 if(mode==='changed-and-ready'){bump(o);setPolicy(o);}
 const failedTest=patch.some(p=>p.op==='test' && p.value!==o.metadata[p.path.split('/').at(-1)]);
 if(mode==='validation')error='The request is invalid: the server rejected our request due to an error in our request';
 else if(mode==='denied')error='Error from server (Forbidden): write denied';
 else if(failedTest)error='The request is invalid: the server rejected our request due to an error in our request';
 else {
  if(mode!=='admission-reverts')setPolicy(o);
  bump(o);
  if(mode==='response-loss')error='connection reset by peer';
 }
 fs.writeFileSync(output,JSON.stringify(o));
}
write('server.json',s);write('calls.json',calls);
if(error){console.error(error);process.exit(1);}
function readPath(p){return JSON.parse(fs.readFileSync(p));}
`);
  const r = bash(dir, `
TIMEOUT_SECONDS=${budget}
sleep() { SECONDS=$((SECONDS+$1)); }
verify_lease() { ${lease ? ':' : "fail LEASE_LOST 'Lease changed'; return 1"}; }
run_capture() {
 local output=$1; shift 2
 LAST_ERROR="$WORKDIR/api.stderr"; LAST_STATUS=0; LAST_COMMAND_ID=command-gateway
 node "$WORKDIR/server.cjs" "$output" "$@" 2>"$LAST_ERROR" || LAST_STATUS=$?
 return "$LAST_STATUS"
}
${full ? 'gateway_reconcile' : `gateway_set_policy ${kind} ${kind === 'service' ? 'envoy-service' : 'envoy'} ${desired} ${grace}`}
`, { MODE: mode, DESIRED: desired });
  return { ...r, calls: JSON.parse(fs.readFileSync(dir + '/calls.json')),
    server: JSON.parse(fs.readFileSync(dir + '/server.json')),
    error: fs.existsSync(dir + '/error.json') ? JSON.parse(fs.readFileSync(dir + '/error.json')) : null,
    events: fs.readFileSync(dir + '/events.jsonl', 'utf8') };
}
const patches = r => r.calls.filter(c => c.verb === 'patch');

for (const kind of ['service', 'envoyproxy']) {
  test(`already-correct ${kind} receives no patch`, t => {
    const r = scenario(t, { kind, policy: 'Cluster' });
    assert.equal(r.status, 0, r.stderr); assert.equal(patches(r).length, 0);
  });
  test(`${kind} conflict rebuilds the patch with its new resourceVersion`, t => {
    const r = scenario(t, { kind, mode: 'conflict' });
    assert.equal(r.status, 0, r.stderr); assert.equal(patches(r).length, 2);
    assert.equal(patches(r)[0].patch[1].value, '1'); assert.equal(patches(r)[1].patch[1].value, '2');
    assert.equal(patches(r)[0].patch[0].path, '/metadata/uid');
    assert.equal(patches(r)[0].patch.length, 3);
  });
}
test('controller convergence during the grace period requires no Service patch', t => {
  const r = scenario(t, { mode: 'controller', grace: 30 });
  assert.equal(r.status, 0, r.stderr); assert.equal(patches(r).length, 0);
});
test('fallback changes only traffic policy and verifies the result through a fresh read', t => {
  const r = scenario(t);
  assert.equal(r.status, 0, r.stderr); assert.equal(patches(r).length, 1);
  assert.equal(patches(r)[0].patch[2].path, '/spec/externalTrafficPolicy');
  assert.equal(r.calls.at(-1).verb, 'get');
  assert.deepEqual(r.server.service.spec.ports, [{ port: 80, targetPort: 8080 }]);
  assert.equal(r.server.service.spec.clusterIP, '10.0.0.5');
});
for (const mode of ['response-loss', 'changed-and-ready']) test(`${mode} is recognized by readback without another write`, t => {
  const r = scenario(t, { mode });
  assert.equal(r.status, 0, r.stderr); assert.equal(patches(r).length, 1);
});
for (const mode of ['validation', 'denied']) test(`${mode} with unchanged state stops with patch evidence`, t => {
  const r = scenario(t, { mode });
  assert.notEqual(r.status, 0); assert.equal(patches(r).length, 1);
  assert.equal(r.error.code, 'GATEWAY_PATCH_REJECTED');
  assert.equal(r.error.diagnostics.commandId, 'command-gateway');
  assert.equal(r.error.diagnostics.currentResourceVersion, '1');
  assert.equal(r.error.diagnostics.patch[2].value, 'Cluster');
  assert.ok(patches(r)[0].args.includes('--v=8'));
});
for (const mode of ['conflict-always', 'admission-reverts']) test(`${mode} never exceeds five writes or reports convergence`, t => {
  const r = scenario(t, { mode });
  assert.notEqual(r.status, 0); assert.equal(patches(r).length, 5);
  assert.equal(r.error.code, 'GATEWAY_CONFLICT');
});
for (const mode of ['foreign', 'foreign-after']) test(`${mode} Service ownership prevents further writes`, t => {
  const r = scenario(t, { mode, foreign: mode === 'foreign' });
  assert.notEqual(r.status, 0); assert.equal(patches(r).length, mode === 'foreign' ? 0 : 1);
  assert.equal(r.error.code, 'GATEWAY_CONFIG');
});
test('lease loss prevents the fallback patch', t => {
  const r = scenario(t, { lease: false });
  assert.notEqual(r.status, 0); assert.equal(patches(r).length, 0); assert.equal(r.error.code, 'LEASE_LOST');
});
test('absent Service waits to the deadline without patching', t => {
  const r = scenario(t, { mode: 'missing', budget: 6 });
  assert.notEqual(r.status, 0); assert.equal(patches(r).length, 0); assert.equal(r.error.code, 'GATEWAY_TIMEOUT');
});
test('full reconciliation reports its own phase and refreshed DNS and policy state', t => {
  const r = scenario(t, { full: true, mode: 'controller' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(patches(r).map(p => p.kind), ['envoyproxy']);
  const events = r.events.trim().split('\n').map(JSON.parse);
  assert.equal(events[0].phase, 'gateway-reconciliation');
  assert.equal(events.find(e => e.type === 'gateway-configured').externalTrafficPolicy, 'Cluster');
  assert.deepEqual(events.find(e => e.type === 'dns').targets, ['192.0.2.5']);
});
test('a recreated controller-owned Service uses a new UID guard', t => {
  const r = scenario(t, { mode: 'recreated' });
  assert.equal(r.status, 0, r.stderr); assert.equal(patches(r).length, 2);
  assert.equal(patches(r)[0].patch[0].value, 'service-uid');
  assert.equal(patches(r)[1].patch[0].value, 'replacement-uid');
});
test('clusters requiring Local traffic policy retain that setting', t => {
  const r = scenario(t, { policy: 'Cluster', desired: 'Local' });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.server.service.spec.externalTrafficPolicy, 'Local');
  assert.equal(patches(r)[0].patch[2].value, 'Local');
});
