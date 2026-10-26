'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, workspace, bash, jq } = require('./helpers.cjs');
const fixture = require('./fixtures/chart-plan.json');
const sets = require('../fixtures/deployment-20261009-sets.json');

test('the Bash chart plan retains the reviewed bootstrap, pinned child charts and runtime charts', t => {
  const dir = workspace(t, { 'config.json': fixture.config, 'tenant-values.json': fixture.config.tenantValues, 'appsets.json': sets });
  const result = bash(dir, `
SOURCE="$WORKDIR/source"
ARGO_SOURCE="$ROOT/test/fixtures/deployment-20261009"
mkdir -p "$SOURCE/XFSC/Applicationsets/values"
write_values
chart_plan
cat "$WORKDIR/chart-jobs.json"
`);
  assert.equal(result.status, 0, result.stderr);
  const jobs = JSON.parse(result.stdout);
  for (const job of jobs) {
    job.root = job.root === dir + '/source' ? 'SOURCE' : job.root === ROOT + '/test/fixtures/deployment-20261009' ? 'ARGO_SOURCE' : 'ROOT';
  }
  jobs.sort((a, b) => a.chart.localeCompare(b.chart) || a.release.localeCompare(b.release));
  assert.deepEqual(jobs, fixture.expected);
});

test('tenant routing retains issuer endpoints and separates verifier and DIDComm routes', () => {
  const defaults = { routes: [
    { name: 'issuer', path: '/api/credential', backend: { name: 'issuance', port: 8080 } },
    { name: 'didcomm', path: '/', backend: { name: 'didcomm-connector', port: 9090 } },
  ], ocm_verifier: [
    { name: 'proof', method: 'GET', path: '/api/verifier/presentation/proof/', pathType: 'PathPrefix', targetPathTemplate: '/v1/tenants/{tenant}/presentation/proof/', backend: { name: 'credential-verification-service', port: 8080 } },
    { name: 'didcomm', path: '/api/didcomm', targetPath: '/', backend: { name: 'didcomm-connector', port: 9090 } },
  ] };
  const c = { ...fixture.config, storageRegion: 'EU', storageCountry: 'DE' };
  const values = jq('tenant_values($defaults)', c, { defaults });
  assert.deepEqual(values.ocm_issuer, [defaults.routes[0]]);
  assert.deepEqual(values.ocm_verifier[0], defaults.ocm_verifier[0]);
  assert.equal(values.ocm_verifier[1].path, '/api/presentation/proof');
  assert.equal(values.ocm_verifier[1].targetPathTemplate, defaults.ocm_verifier[0].targetPathTemplate);
  assert.deepEqual(values.ocm_verifier[2], { name: 'didcomm-message', method: 'POST', path: '/api/didcomm/message/receive', pathType: 'Exact', targetPath: '/message/receive', backend: { name: 'didcomm-connector', port: 9090 } });
  assert.equal(values.openbao.transit.mountPath, 'ocm-wstack/' + c.tenantId);
  assert.equal(values.tenant.country, 'DE');
  assert.equal(values.certificate.enabled, false);
  assert.equal(values.routes, undefined);
  assert.equal(jq('tenant_values($defaults)', { ...c, runtimeServices: { didcomm: 'http://external.example' } }, { defaults }).ocm_verifier.length, 2);
  assert.throws(() => jq('tenant_values($defaults)', c, { defaults: { routes: defaults.routes } }));
});

test('chart planning rejects unexpected generators before chart rendering or installation', t => {
  const changed = structuredClone(sets); changed.storage.matrix.enabled = true;
  const dir = workspace(t, { 'config.json': fixture.config, 'tenant-values.json': fixture.config.tenantValues, 'appsets.json': changed });
  const result = bash(dir, 'SOURCE="$WORKDIR/source"; ARGO_SOURCE="$ROOT/test/fixtures/deployment-20261009"; mkdir -p "$SOURCE/XFSC/Applicationsets/values"; write_values; chart_plan');
  assert.notEqual(result.status, 0);
});
