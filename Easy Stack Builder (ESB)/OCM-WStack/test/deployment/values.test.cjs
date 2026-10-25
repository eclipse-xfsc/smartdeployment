'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { jq, workspace, bash } = require('./helpers.cjs');
const lock = require('../../upstream-lock.json');
const fixtures = require('./fixtures/values.json');

for (const fixture of fixtures) {
  test(`preserve ${fixture.name}`, () => {
    assert.deepEqual(jq(fixture.expression, fixture.input, { lock, ...fixture.vars }), fixture.expected);
  });
}

const input = { procedureVersion: 12, domain: 'example.com', runtimeImage: 'example.invalid/ocm:12.4.0' };
for (const [field, value] of [
  ['procedureVersion', 11], ['domain', 'https://example.com'], ['domain', 'example.com/path'],
  ['instanceName', '../elsewhere'], ['tenantId', 'Bad Tenant'], ['tenantSubdomain', 'two.parts'],
  ['tenantRelease', 'a'.repeat(36)], ['storageClass', 'bad/class'], ['provider', 'unknown'],
  ['dnsProvider', 'unknown'], ['timeoutSeconds', 1], ['timeoutSeconds', 1.5], ['timeoutSeconds', 7201],
  ['lbAnnotations', { bad: 1 }], ['runtimeServices', { storage: 'https://user:password@example.com' }],
  ['runtimeServices', { storage: 'https://example.com?secret=value' }], ['runtimeServices', { foreign: 'http://example.com' }],
  ['orceStorageSize', '0Gi'], ['runtimeImage', 'example.invalid/ocm:latest'], ['uiAdminUsername', 'admin; command'],
]) {
  test(`reject invalid ${field}: ${JSON.stringify(value)}`, () => {
    assert.throws(() => jq('normalize_config', { ...input, [field]: value }));
  });
}

test('provider fallback and mixed node evidence remain distinct', () => {
  const classes = { items: [{ provisioner: 'cloud.ionos.com' }] };
  assert.equal(jq('detect_provider($nodes;$classes)', {}, { nodes: { items: [{}] }, classes }).provider, 'ionos');
  assert.equal(jq('detect_provider($nodes;$classes)', {}, {
    nodes: { items: [{ spec: { providerID: 'aws:///a' } }, { spec: { providerID: 'hcloud://b' } }] }, classes,
  }).provider, 'generic');
});

test('host alias replacement preserves unrelated names and removes stale tenant mappings', () => {
  assert.deepEqual(jq('host_aliases("tenant.example";"10.0.0.2")', [
    { ip: '10.0.0.1', hostnames: ['tenant.example', 'keep.example'] },
    { ip: '10.0.0.2', hostnames: ['other.example'] },
  ]), [{ ip: '10.0.0.1', hostnames: ['keep.example'] }, { ip: '10.0.0.2', hostnames: ['other.example', 'tenant.example'] }]);
});

test('IPv4 and IPv6 validation rejects malformed addresses and normalizes equivalent IPv6 forms', () => {
  for (const address of ['192.0.2.1', '0.0.0.0']) assert.equal(jq('ip_family', address), 4);
  for (const address of ['2001:db8::1', '::1', '::', '::ffff:192.0.2.1']) assert.equal(jq('ip_family', address), 6);
  for (const address of ['999.2.3.4', '01.2.3.4', '2001:::1', '1::2::3', '2001:bad', 'fe80::1%eth0', 'localhost']) {
    assert.equal(jq('ip_family', address), 0, address);
  }
  assert.equal(jq('ip_key', '2001:DB8:0:0:0:0:0:1'), jq('ip_key', '2001:db8::1'));
});

test('MongoDB URI parsing retains all required ports and rejects invalid SRV forms', t => {
  const directory = workspace(t);
  for (const [uri, ports] of [
    ['mongodb://user:pass@one:27017,two:27018/db', [27017, 27018]],
    ['mongodb+srv://user:pass@db.example/db', [27017]],
    ['mongodb://[2001:db8::1]:27018/db', [27018]],
  ]) {
    const result = bash(directory, 'printf \'%s\' "$URI" | mongo_ports', { URI: JSON.stringify(uri) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ports);
  }
  for (const uri of ['https://db.example', 'mongodb+srv://db.example:27018/db', 'mongodb://one:70000/db']) {
    assert.notEqual(bash(directory, 'printf \'%s\' "$URI" | mongo_ports', { URI: JSON.stringify(uri) }).status, 0);
  }
});
