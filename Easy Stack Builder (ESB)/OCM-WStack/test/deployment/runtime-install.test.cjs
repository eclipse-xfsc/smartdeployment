'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { workspace, bash } = require('./helpers.cjs');
const fixture = require('./fixtures/chart-plan.json');

test('runtime installation discovers service ports, creates private hashes and retains them on resume', t => {
  const config = { ...fixture.config, runtimeImage: 'registry.example.com/ocm-ui:12.4.0',
    publicDashboards: false, useExternalMongo: false, runtimeServices: {}, editorUsername: 'admin', uiAdminUsername: 'admin' };
  const dir = workspace(t, { 'config.json': config,
    'credentials.json': { editorPassword: 'editor-test-password', uiAdminPassword: 'admin-test-password' },
    'service-list.json': { items: [{ metadata: { name: 'storage-service' }, spec: { ports: [{ name: 'http', port: 8181 }] } }] },
    'retained.json': null,
  });
  const code = `
get_optional() {
  if [[ $4 == ocm-orce-runtime ]]; then cp "$WORKDIR/retained.json" "$1";
  elif [[ $4 == credential-retrieval-service ]]; then printf null >"$1";
  else return 9; fi
}
kube_json() { cp "$WORKDIR/service-list.json" "$1"; }
run() {
  if [[ $3 == create ]]; then
    jq '{metadata:.metadata,type:.type,data:{"secrets.json":(.stringData["secrets.json"]|@base64)}}' "$WORKDIR/runtime-secret-new.json" >"$WORKDIR/retained.json"
    printf created >>"$WORKDIR/create-count"
  fi
}
gateway_ports() {
  printf '{"spec":{"clusterIP":"10.0.0.10"}}' >"$WORKDIR/gateway-service.json"
  printf '[80,443,10443]'
}
helm_upgrade() { cp "$WORKDIR/runtime-values.json" "$WORKDIR/installed-values.json"; }
runtime_install
cat "$WORKDIR/runtime-result.json"
`;
  const first = bash(dir, code);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).authentication, 'mongodb-24h-session');
  const secret = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(dir + '/retained.json')).data['secrets.json'], 'base64'));
  assert.match(secret.editorHash, /^\$2[aby]\$12\$/);
  assert.match(secret.uiAdminHash, /^\$2[aby]\$12\$/);
  assert.match(secret.offerKey, /^[a-f0-9]{64}$/);
  const values = JSON.parse(fs.readFileSync(dir + '/installed-values.json'));
  assert.equal(values.runtimeConfig.services.storage, 'http://storage-service.ocm-wstack.svc.cluster.local:8181');
  assert.equal(values.mongo.embedded, true);
  assert.deepEqual(values.gatewayPorts, [80, 443, 10443]);
  const publicOutput = first.stdout + first.stderr + fs.readFileSync(dir + '/events.jsonl') + JSON.stringify(values);
  for (const privateValue of ['editor-test-password', 'admin-test-password', secret.editorHash, secret.offerKey, secret.mongoUri]) {
    assert.equal(publicOutput.includes(privateValue), false);
  }
  fs.writeFileSync(dir + '/credentials.json', '{}');
  const resumed = bash(dir, code);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(dir + '/retained.json')).data['secrets.json'], 'base64')), secret);
  assert.equal(fs.readFileSync(dir + '/create-count', 'utf8'), 'created');
});
