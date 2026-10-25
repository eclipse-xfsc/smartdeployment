'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { ROOT, workspace } = require('../deployment/helpers.cjs');
const { credentialsPath } = require('../../runtime/lib/storage-path.cjs');
const { Adapters } = require('../../runtime/lib/adapters.cjs');

test('storage diagnostic reads health, Swagger and scoped records without emitting response contents', async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push([req.method, req.url]);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/swagger/doc.json') res.end(JSON.stringify({ paths: { '/credentials': {}, '/presentations': {} }, secret: 'must-not-leak' }));
    else if (req.method === 'POST') { res.statusCode = 400; res.end(JSON.stringify({ message: 'Region Id Missing.', credentials: { private: 'must-not-leak' } })); }
    else res.end(JSON.stringify({ status: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dir = workspace(t, { 'config.json': { services: { storage: `http://127.0.0.1:${server.address().port}` }, tenant: 'tenant', account: 'account', group: 'group' } });
  const child = spawn(process.execPath, [ROOT + '/runtime/tools/diagnose-storage.cjs'], { env: { ...process.env, OCM_RUNTIME_CONFIG: dir + '/config.json' } });
  let output = '', error = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { error += data; });
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, error);
  assert.equal(output.includes('must-not-leak'), false);
  const report = JSON.parse(output);
  assert.equal(report.checks[2].nativeMessage, 'Region Id Missing.');
  assert.equal(report.checks[1].storagePaths.length, 2);
  assert.deepEqual(seen.sort(), [['GET', '/swagger/doc.json'], ['GET', '/v1/metrics/health'], ['POST', '/v1/tenants/tenant/storage/EU/DE/account/credentials']].sort());
});

test('Storage scopes list and deletion requests to the configured geography', async () => {
  const calls = [];
  const adapters = new Adapters({ storageRegion: 'EU', storageCountry: 'NL' }, { call: async (name, path, options) => { calls.push({ name, path, options }); return { credentials: {} }; } });
  const context = { tenant: 'demo-tenant', account: 'ocm-wstack', group: 'ocm-wstack' };
  await adapters.records(context);
  await adapters.remove(context, 'record-1');
  assert.equal(calls[0].path, '/v1/tenants/demo-tenant/storage/EU/NL/ocm-wstack/credentials');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[1].path, calls[0].path + '/record-1');
  assert.equal(calls[1].options.method, 'DELETE');
  assert.equal(credentialsPath(context), '/v1/tenants/demo-tenant/storage/EU/DE/ocm-wstack/credentials');
  assert.throws(() => credentialsPath({ ...context, account: '..' }));
});
