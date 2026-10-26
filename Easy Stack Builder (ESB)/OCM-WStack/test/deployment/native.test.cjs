'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { ROOT, workspace, bash, bashAsync } = require('./helpers.cjs');

test('Cassandra compatibility patches only native probe timing with a resource-version precondition', t => {
  const probe = { exec: { command: ['/bin/bash', '-ec', 'nodetool statusbinary | grep -q running'] }, timeoutSeconds: 1, failureThreshold: 3 };
  const dir = workspace(t, { 'native.json': { metadata: { resourceVersion: '41' }, spec: { template: { spec: { containers: [
    { name: 'cassandra', image: 'docker.io/library/cassandra:5.0', startupProbe: probe, readinessProbe: probe, livenessProbe: probe },
  ] } } } } });
  const script = `
get_optional() { if [[ $3 == clusterpolicy ]]; then printf null >"$1"; else cp "$WORKDIR/native.json" "$1"; fi; }
apply_json() { :; }
run() { :; }
cassandra_compatibility
cat "$WORKDIR/cassandra-patch.json"
`;
  const r = bash(dir, script);
  assert.equal(r.status, 0, r.stderr);
  const patch = JSON.parse(r.stdout);
  assert.deepEqual(patch[0], { op: 'test', path: '/metadata/resourceVersion', value: '41' });
  assert.equal(patch.length, 5);
  assert.ok(patch.slice(1).every(p => /\/(?:startupProbe|readinessProbe|livenessProbe)\/(?:timeoutSeconds|failureThreshold)$/.test(p.path)));
  const changed = JSON.parse(fs.readFileSync(dir + '/native.json'));
  changed.spec.template.spec.containers[0].readinessProbe.exec.command = ['different-probe'];
  fs.writeFileSync(dir + '/native.json', JSON.stringify(changed));
  assert.notEqual(bash(dir, script).status, 0);
});

test('native Storage geography comes from Retrieval and rejects indirect or invalid values', t => {
  const deployment = { spec: { template: { spec: { containers: [{ name: 'credential-retrieval-service', env: [
    { name: 'CREDENTIALRETRIEVAL_REGION', value: 'EU' }, { name: 'CREDENTIALRETRIEVAL_COUNTRY', value: 'NL' },
  ] }] } } } };
  const dir = workspace(t, { 'retrieval.json': deployment });
  const script = 'get_optional() { cp "$WORKDIR/retrieval.json" "$1"; }; discover_storage_scope; cat "$CONFIG"';
  const r = bash(dir, script);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { storageRegion: 'EU', storageCountry: 'NL' });
  deployment.spec.template.spec.containers[0].env[1] = { name: 'CREDENTIALRETRIEVAL_COUNTRY', valueFrom: { secretKeyRef: { name: 'external', key: 'country' } } };
  fs.writeFileSync(dir + '/retrieval.json', JSON.stringify(deployment));
  assert.notEqual(bash(dir, script).status, 0);
});

test('native credential exercise follows offer, intake, acceptance and Storage read-back with explicit confirmation', async t => {
  const seen = [];
  const requestId = '12345678-1234-1234-1234-123456789abc';
  const credential = 'encoded.credential.signature';
  let accepted = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/test/offering/create') res.end(JSON.stringify({ offer: { credential_offer: 'offer-content' } }));
      else if (req.url.includes('/retrieve/')) res.end(JSON.stringify(requestId));
      else if (req.url.includes('/list/')) res.end(JSON.stringify([{ requestId }]));
      else if (req.url.includes('/clear/')) { accepted = true; res.end(JSON.stringify({ credentials: [credential] })); }
      else res.end(JSON.stringify({ credentials: accepted ? [credential] : [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const dir = workspace(t, { 'config.json': { tenantId: 'tenant', tenantUrl: url, storageRegion: 'EU', storageCountry: 'NL' } });
  const script = `
discover_storage_scope() { :; }
start_tunnel() { printf '%s' "$TEST_URL" >"$2"; }
CONFIRM="$CONFIRMATION"
test_credentials
`;
  const denied = await bashAsync(dir, script, { TEST_URL: url, CONFIRMATION: '' }).result;
  assert.notEqual(denied.status, 0);
  assert.equal(seen.length, 0);
  const r = await bashAsync(dir, script, { TEST_URL: url, CONFIRMATION: 'CREATE TEST CREDENTIAL' }).result;
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.status, 'passed', r.stdout + r.stderr);
  assert.equal(report.credentialLifecycle, 'retrieved-and-read-back');
  assert.equal(report.credentialCount, 1);
  assert.equal(report.retainedTestData, true);
  assert.equal(report.checks.length, 6);
  assert.equal(r.stdout.includes(credential), false);
  assert.deepEqual(seen.map(row => row.method), ['POST', 'POST', 'PUT', 'GET', 'DELETE', 'POST']);
  assert.ok(seen[0].url.includes('/storage/EU/NL/esb-check-'));
  assert.equal(seen[4].body.holderKey, 'eckey');
});
