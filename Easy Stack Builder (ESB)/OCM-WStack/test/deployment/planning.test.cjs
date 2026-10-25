'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, workspace, bash, jq } = require('./helpers.cjs');
const fixture = require('./fixtures/chart-plan.json');
const sets = require('../fixtures/deployment-20261009-sets.json');

test('the Bash chart plan retains the reviewed bootstrap, selected current-main children and runtime charts', t => {
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

test('tenant routing preserves native routes and exposes only the DIDComm message endpoint', () => {
  const defaults = { routes: [
    { name: 'issuer', path: '/api/credential', backend: { name: 'issuance', port: 8080 } },
    { name: 'didcomm', path: '/', backend: { name: 'didcomm-connector', port: 9090 } },
  ] };
  const c = fixture.config;
  const values = jq('tenant_values($defaults)', c, { defaults });
  assert.deepEqual(values.routes[0], defaults.routes[0]);
  assert.equal(values.routes[1].enabled, false);
  assert.deepEqual(values.routes[2], { name: 'didcomm-message', method: 'POST', path: '/api/didcomm/message/receive', pathType: 'Exact', targetPath: '/message/receive', backend: { name: 'didcomm-connector', port: 9090 } });
  assert.equal(values.openbao.transit.mountPath, 'ocm-wstack/' + c.tenantId);
  assert.equal(values.certificate.enabled, false);
  assert.equal(jq('tenant_values($defaults)', { ...c, runtimeServices: { didcomm: 'http://external.example' } }, { defaults }).routes.length, 2);
});

test('chart planning rejects unexpected generators before chart rendering or installation', t => {
  const changed = structuredClone(sets); changed.storage.matrix.enabled = true;
  const dir = workspace(t, { 'config.json': fixture.config, 'tenant-values.json': fixture.config.tenantValues, 'appsets.json': changed });
  const result = bash(dir, 'SOURCE="$WORKDIR/source"; ARGO_SOURCE="$ROOT/test/fixtures/deployment-20261009"; mkdir -p "$SOURCE/XFSC/Applicationsets/values"; write_values; chart_plan');
  assert.notEqual(result.status, 0);
});
