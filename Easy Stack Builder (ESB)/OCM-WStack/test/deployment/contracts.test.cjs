'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { jq, workspace, bash } = require('./helpers.cjs');
const fixture = require('./fixtures/reconciler.json');
const copy = () => structuredClone(fixture);

function redis(f) {
  return jq('contracts', 'redis_contract($claims;$provider;$secrets;$admin;$external)', f.deployments[0], {
    claims: f.claims, provider: f.provider, secrets: f.secrets, admin: f.admin, external: f.externalSecrets,
  });
}
function listeners(f) {
  return jq('contracts', 'service_listeners($pods;$replicasets;$connections)', f.deployments[0], f);
}
function verification(f) {
  return jq('contracts', 'verification_nats_ready($pods;$replicasets)', f.deployments[2], f);
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
    const references = jq('contracts', 'credential_references($secrets)', f.deployments[0], { secrets: f.secrets });
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
  return jq('contracts', 'api_backends($slices;$endpoints) as $backends | api_egress($backends)', f.service, f);
}
test('API egress selects exact Service and ready backend IP/port pairs', () => {
  const f = apiFixture();
  assert.deepEqual(routes(f).map(x => [x.ports[0].port, x.to.map(p => p.ipBlock.cidr)]), [[443, ['100.64.0.1/32']], [16443, ['192.0.2.10/32']]]);
  f.slices.items = [];
  assert.deepEqual(routes(f).map(x => [x.ports[0].port, x.to.map(p => p.ipBlock.cidr)]), [[443, ['100.64.0.1/32']], [15370, ['213.165.72.144/32']]]);
});
test('API egress rejects invalid IPs, families, ports and absent backends', () => {
  for (const mutate of [
    f => { f.service.spec.clusterIP = '999.1.1.1'; },
    f => { f.service.spec.ports[0].port = 0; },
    f => { f.service.metadata.namespace = 'foreign'; },
    f => { f.slices.items[0].ports[0].port = 70000; },
    f => { f.slices.items[0].endpoints[0].addresses = ['2001:db8::1']; },
    f => { f.slices.items = []; f.endpoints = null; },
  ]) { const f = apiFixture(); mutate(f); assert.throws(() => routes(f)); }
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
