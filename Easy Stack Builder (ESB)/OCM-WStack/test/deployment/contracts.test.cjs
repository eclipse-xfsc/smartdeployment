'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, jq, workspace, bash } = require('./helpers.cjs');
const { spawnSync } = require('node:child_process');
const fixture = require('./fixtures/reconciler.json');
const copy = () => structuredClone(fixture);

function redis(f) {
  return jq('redis_contract($claims;$provider;$secrets;$admin;$external)', f.deployments[0], {
    claims: f.claims, provider: f.provider, secrets: f.secrets, admin: f.admin, external: f.externalSecrets,
  });
}
function listeners(f) {
  return jq('service_listeners($pods;$replicasets;$connections)', f.deployments[0], f);
}
function verification(f) {
  return jq('verification_nats_ready($pods;$replicasets)', f.deployments[2], f);
}

test('pending Redis claims retain the ESO account and exact ACL scope', () => {
  assert.deepEqual(redis(copy()), fixture.expectedRedis);
  for (const mutate of [
    f => { f.secrets[0].data.username = Buffer.from('default').toString('base64'); },
    f => { f.claims[0].spec.parameters.acl.keys = ['*']; },
    f => { f.provider.spec.outputs.env.REDIS_TLS = 'true'; },
    f => { f.provider.spec.outputs.env.REDIS_HOSTS = 'other.example:6379'; },
    f => { f.externalSecrets[0].spec.target.name = 'unrelated'; },
  ]) {
    const f = copy(); mutate(f); assert.throws(() => redis(f));
  }
});

test('listeners require current replicas, images, credentials and every native subject', () => {
  assert.deepEqual(listeners(copy()), fixture.expectedListeners);
  for (const mutate of [
    f => { f.pods[0].metadata.ownerReferences[0].uid = 'foreign'; },
    f => { f.pods[0].metadata.deletionTimestamp = 'now'; },
    f => { f.pods[0].metadata.annotations['esb.xfsc.io/credentials'] = 'stale'; },
    f => { f.pods[0].spec.containers[0].image = 'obsolete:tag'; },
    f => { f.pods[0].status.podIP = '10.1.1.1'; },
    f => { f.deployments[0].status.observedGeneration = 0; },
    f => { f.connections[0].subscriptions_list.pop(); },
  ]) {
    const f = copy(); mutate(f); assert.equal(listeners(f).ready, false);
  }
});

test('verification checks exact injected values on the deployment and current pods', () => {
  assert.equal(verification(copy()), true);
  for (const mutate of [
    f => { f.deployments[2].spec.template.spec.containers[0].env[0].value = 'wrong'; },
    f => { f.deployments[2].spec.template.spec.containers[0].env.push(f.deployments[2].spec.template.spec.containers[0].env[0]); },
    f => { f.pods[2].spec.containers[0].env[0].value = 'wrong'; },
    f => { f.pods[2].metadata.annotations['esb.xfsc.io/credentials'] = 'stale'; },
    f => { f.pods[2].spec.containers[0].image = 'obsolete:tag'; },
  ]) { const f = copy(); mutate(f); assert.equal(verification(f), false); }
});

test('credential checksums track referenced bytes, init containers and volumes', t => {
  const f = copy();
  const digest = () => {
    const references = jq('credential_references($secrets)', f.deployments[0], { secrets: f.secrets });
    return crypto.createHash('sha256').update(JSON.stringify(references)).digest('hex');
  };
  const first = digest();
  assert.equal(first, f.deployments[0].spec.template.metadata.annotations['esb.xfsc.io/credentials']);
  f.secrets[0].metadata.resourceVersion = 'new'; f.secrets[0].data.unused = 'ZXh0cmE=';
  assert.equal(digest(), first);
  f.deployments[0].spec.template.spec.initContainers = [{ envFrom: [{ secretRef: { name: f.secrets[0].metadata.name } }] }];
  const all = digest(); f.secrets[0].data.unused = 'bmV3'; assert.notEqual(digest(), all);
  f.deployments[0].spec.template.spec.initContainers = [];
  f.deployments[0].spec.template.spec.volumes = [{ projected: { sources: [{ secret: { name: f.secrets[0].metadata.name, items: [{ key: 'unused', path: 'key' }] } }] } }];
  const volume = digest(); f.secrets[0].data.unused = 'b2xk'; assert.notEqual(digest(), volume);
  delete f.secrets[0].data.password; assert.throws(digest, /CONSUMER_SECRET_KEY_PENDING/);

  const dir = workspace(t, { 'deployment.json': fixture.deployments[0], 'secrets.json': fixture.secrets });
  const result = bash(dir, 'source "$DEPLOYMENT/reconcile.sh"; STATE_DIR="$WORKDIR"; credential_digest "$WORKDIR/deployment.json" "$WORKDIR/secrets.json" "$WORKDIR/hash.json"; cat "$WORKDIR/hash.json"');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), first);
});

function apiFixture() {
  return {
    service: { metadata: { name: 'kubernetes', namespace: 'default' }, spec: { clusterIP: '100.64.0.1', clusterIPs: ['100.64.0.1'], ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 15370 }] } },
    slices: { items: [{ metadata: { namespace: 'default', labels: { 'kubernetes.io/service-name': 'kubernetes' } }, addressType: 'IPv4', ports: [{ name: 'https', port: 16443, protocol: 'TCP' }], endpoints: [{ addresses: ['192.0.2.10'], conditions: { ready: true } }, { addresses: ['192.0.2.20'], conditions: { ready: false } }] }] },
    endpoints: { metadata: { name: 'kubernetes', namespace: 'default' }, subsets: [{ addresses: [{ ip: '213.165.72.144' }], notReadyAddresses: [{ ip: '192.0.2.99' }], ports: [{ name: 'https', port: 15370, protocol: 'TCP' }] }] },
  };
}
function routes(f) {
  return jq('api_backends($slices;$endpoints) as $backends | api_egress($backends)', f.service, f);
}
test('API egress selects exact Service and ready backend IP/port pairs', () => {
  const f = apiFixture();
  assert.deepEqual(routes(f).map(x => [x.ports[0].port, x.to.map(p => p.ipBlock.cidr)]), [[443, ['100.64.0.1/32']], [16443, ['192.0.2.10/32']]]);
  f.slices.items = [];
  assert.deepEqual(routes(f).map(x => [x.ports[0].port, x.to.map(p => p.ipBlock.cidr)]), [[443, ['100.64.0.1/32']], [15370, ['213.165.72.144/32']]]);
});
test('API egress rejects invalid IPs, families, ports and absent backends', () => {
  for (const [mutate, code] of [
    [f => { f.service.spec.clusterIP = '999.1.1.1'; }, 'GUARD_API_SERVICE'],
    [f => { f.service.spec.ports[0].port = 0; }, 'GUARD_API_SERVICE'],
    [f => { f.service.metadata.namespace = 'foreign'; }, 'GUARD_API_SERVICE'],
    [f => { f.slices.items[0].ports[0].port = 70000; }, 'GUARD_API_ENDPOINTS'],
    [f => { f.slices.items[0].endpoints[0].addresses = ['2001:db8::1']; }, 'GUARD_API_ENDPOINTS'],
    [f => { f.slices.items = []; f.endpoints = null; }, 'GUARD_API_ENDPOINTS_PENDING'],
  ]) {
    const f = apiFixture(); mutate(f);
    assert.throws(() => routes(f), error => {
      assert.match(error.message, /exit=5, signal=none/);
      assert.match(error.message, new RegExp(code + '$'));
      return true;
    });
  }
});

test('dual-stack API egress retains exact address and port pairs', () => {
  const f = apiFixture();
  f.service.spec.clusterIPs.push('fd00::1');
  f.slices.items.push({ ...structuredClone(f.slices.items[0]), addressType: 'IPv6',
    ports: [{ name: 'https', port: 6443 }],
    endpoints: [{ addresses: ['2001:db8::10'], conditions: { ready: true } },
      { addresses: ['2001:db8::20'], conditions: { ready: true, terminating: true } }] });
  assert.deepEqual(routes(f).map(x => [x.ports[0].port, x.to.map(p => p.ipBlock.cidr)]), [
    [443, ['100.64.0.1/32', 'fd00::1/128']],
    [6443, ['2001:db8::10/128']],
    [16443, ['192.0.2.10/32']],
  ]);
});

test('installed reconciler receives the executable filters and discovered API egress', t => {
  const f = apiFixture();
  const dir = workspace(t, { 'config.json': { runtimeImage: 'example.invalid/ocm:12.4.0' },
    'service.json': f.service, 'slices.json': f.slices,
    'dns-service.json':{metadata:{name:'kube-dns',namespace:'kube-system'},spec:{selector:{'k8s-app':'kube-dns'},ports:[{name:'dns',port:53,protocol:'UDP'},{name:'dns-tcp',port:53,protocol:'TCP'}]}},
    'dns-fixture.json':{items:[{metadata:{namespace:'kube-system',labels:{'kubernetes.io/service-name':'kube-dns'}},ports:[{name:'dns',port:8053,protocol:'UDP'},{name:'dns-tcp',port:8053,protocol:'TCP'}],endpoints:[{conditions:{ready:true}}]}]} });
  const result = bash(dir, `
    kube_json() {
      case "$*" in
        *kube-system*endpointslices*) cp "$WORKDIR/dns-fixture.json" "$1" ;;
        *kube-system*service*) jq '{items:[.]}' "$WORKDIR/dns-service.json" >"$1" ;;
        *endpointslices*) cp "$WORKDIR/slices.json" "$1" ;;
        *service*) cp "$WORKDIR/service.json" "$1" ;;
        *) return 1 ;;
      esac
    }
    get_optional() { printf 'null\\n' >"$1"; }
    apply_json() { cp "$1" "$WORKDIR/installed.json"; }
    install_reconciler
  `);
  assert.equal(result.status, 0, result.stderr);
  const { items } = JSON.parse(fs.readFileSync(path.join(dir, 'installed.json')));
  const data = items.find(item => item.kind === 'ConfigMap').data;
  assert.deepEqual(Object.keys(data).sort(), ['filters.jq', 'reconcile.sh']);
  const mounted = path.join(dir, 'mounted');
  fs.mkdirSync(mounted);
  for (const [name, content] of Object.entries(data)) {
    assert.equal(content, fs.readFileSync(path.join(ROOT, 'deployment', name), 'utf8'));
    fs.writeFileSync(path.join(mounted, name), content);
  }
  const checksum = crypto.createHash('sha256').update(data['reconcile.sh']).update(data['filters.jq']).digest('hex');
  assert.equal(items.find(item => item.kind === 'Deployment').spec.template.metadata.annotations['esb.xfsc.io/source'], checksum);
  const egress = items.find(item => item.kind === 'NetworkPolicy').spec.egress;
  assert.ok(egress.some(rule=>rule.ports.some(p=>p.port===8053)));
  assert.deepEqual(items.find(item=>item.kind==='Deployment').spec.template.spec.containers[0].env,[
    {name:'OCM_GUARD_API_ADDRESS',value:'100.64.0.1'}, {name:'OCM_GUARD_API_PORT',value:'443'},
  ]);
  for (const rule of routes(f)) assert.ok(egress.some(item => JSON.stringify(item) === JSON.stringify(rule)));
  const run = spawnSync('bash', ['-c', 'source "$1/reconcile.sh"; guard_filter \'ip_family\' <<<\'"2001:db8::1"\'', 'bash', mounted], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout), 6);
});

test('runtime preflight retains existing secrets and refuses a different tenant', t => {
  const c = { runtimeImage: 'example.invalid/ocm:12.4.0', tenantId: 'demo-tenant', tenantHost: 'demo-tenant.example.com', editorUsername: 'admin', useExternalMongo: false, publicDashboards: false };
  const secret = { editorHash: 'hash', uiAdminHash: 'hash', editorUsername: 'admin', credentialSecret: 's', offerKey: 'key', mongoPassword: 'pass', mongoUri: 'mongodb://user:pass@ocm-ui-mongodb.ocm-wstack.svc.cluster.local:27017/db', tenantId: c.tenantId, tenantHost: c.tenantHost };
  const directory = workspace(t, { 'config.json': c, 'retained.json': { data: { 'secrets.json': Buffer.from(JSON.stringify(secret)).toString('base64') } } });
  const code = 'get_optional() { cp "$WORKDIR/retained.json" "$1"; }; runtime_preflight; cat "$WORKDIR/runtime-secrets.json"';
  const result = bash(directory, code);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), secret);
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ ...c, tenantId: 'other' }));
  assert.notEqual(bash(directory, code).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'error.json'))).code, 'RUNTIME_SECRET');
});
