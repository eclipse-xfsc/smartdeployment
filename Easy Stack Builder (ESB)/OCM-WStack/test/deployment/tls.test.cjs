'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { workspace, bash } = require('./helpers.cjs');

function certificates(t) {
  const dir = workspace(t, { 'extensions': 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:*.example.com,DNS:demo.example.net\n' });
  const openssl = args => {
    const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Deployment test CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=demo.example.com']);
  openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'leaf.pem', '-days', '1', '-extfile', 'extensions']);
  fs.writeFileSync(dir + '/chain.pem', fs.readFileSync(dir + '/leaf.pem') + fs.readFileSync(dir + '/ca.pem'));
  return dir;
}

test('uploaded TLS accepts a matching key, ordered trusted chain and one-label wildcard', t => {
  const dir = certificates(t);
  for (const host of ['demo.example.com', 'grafana.example.com', 'demo.example.net']) {
    const r = bash(dir, `tls_validate "$WORKDIR/chain.pem" "$WORKDIR/leaf.key" "${host}"`, { SSL_CERT_FILE: dir + '/ca.pem' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  }
});

test('uploaded TLS rejects a mismatched key, a nested wildcard name and an untrusted chain', t => {
  const dir = certificates(t);
  for (const [key, host, trust, expected] of [
    ['ca.key', 'demo.example.com', true, 'TLS_KEY_MISMATCH'],
    ['leaf.key', 'nested.demo.example.com', true, 'TLS_HOSTNAME'],
    ['leaf.key', 'demo.example.com', false, 'TLS_CHAIN'],
  ]) {
    const r = bash(dir, `tls_validate "$WORKDIR/chain.pem" "$WORKDIR/${key}" "${host}"`, trust ? { SSL_CERT_FILE: dir + '/ca.pem' } : {});
    assert.notEqual(r.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(dir + '/error.json')).code, expected);
    assert.equal(r.stdout.includes('PRIVATE KEY'), false);
  }
});

test('TLS installation preserves an identical Secret and rejects foreign ownership', t => {
  const dir = workspace(t, { 'config.json': { tenantRelease: 'demo', instanceName: 'ocm', tenantHost: 'demo.example.com' },
    'fullchain.pem': 'certificate', 'private-key.pem': 'private-key', 'old.json': {
      metadata: { labels: { 'app.kubernetes.io/managed-by': 'esb-ocmwstack' } }, type: 'kubernetes.io/tls',
      data: { 'tls.crt': Buffer.from('certificate').toString('base64'), 'tls.key': Buffer.from('private-key').toString('base64') },
    } });
  const script = 'get_optional() { cp "$WORKDIR/old.json" "$1"; }; run() { printf unexpected-mutation; return 9; }; tls_install';
  const retained = bash(dir, script);
  assert.equal(retained.status, 0, retained.stderr);
  assert.equal(retained.stdout, '');
  const old = JSON.parse(fs.readFileSync(dir + '/old.json'));
  old.metadata.labels['app.kubernetes.io/managed-by'] = 'another-owner';
  fs.writeFileSync(dir + '/old.json', JSON.stringify(old));
  const foreign = bash(dir, script);
  assert.notEqual(foreign.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(dir + '/error.json')).code, 'TLS_OWNERSHIP');
});
