'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, jq, workspace, bash } = require('./helpers.cjs');
const lock = require('../../upstream-lock.json');
const overrides = require('../../deployment/templates/native-overrides.json');

test('bootstrap and every ApplicationSet use the reviewed deployment commit', () => {
  assert.match(lock.commit, /^[a-f0-9]{40}$/);
  assert.equal(lock.argoRevision, lock.commit);
  const patch = fs.readFileSync(path.join(ROOT, 'deployment/upstream.patch'), 'utf8');
  const added = patch.split('\n').filter(line => line.startsWith('+')).join('\n');
  assert.ok(!added.includes('tag=main'));
  assert.equal((added.match(/--set-string tag="\$\{ESB_DEPLOYMENT_REVISION/g) || []).length, 4);
  assert.ok(added.includes('.spec.source.targetRevision // "") != env.ESB_DEPLOYMENT_REVISION'));
  assert.ok(added.includes('.status.sync.comparedTo.source.targetRevision // "") != env.ESB_DEPLOYMENT_REVISION'));
  for (const chart of require('./fixtures/chart-plan.json').expected.filter(x => x.chart === 'XFSC/Applicationsets/chart')) {
    assert.equal(chart.values.tag, lock.commit);
  }
});

test('checkout rejects a moving Argo revision before starting a download', t => {
  const dir = workspace(t, { 'upstream-lock.json': { ...lock, argoRevision: 'main' } });
  const result = bash(dir, 'ROOT="$WORKDIR"; run() { printf unexpected-download; return 9; }; checkout_source');
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(fs.readFileSync(dir + '/error.json')).code, 'UPSTREAM_COMMIT');
});

test('native overrides select Policy 1.1.2, its policy repository and provider-backed verification', () => {
  const policy = overrides['OCM W-Stack/Policy Chart'].policy;
  assert.equal(policy.image.tag, '1.1.2');
  assert.equal(policy.memoryStorage.policiesRepo, 'https://github.com/eclipse-xfsc/rego-policies.git');
  assert.equal(policy.memoryStorage.policiesFolder, 'Policies');
  assert.equal(policy.policy.http.port, policy.service.port);
  const verifier = overrides['OCM W-Stack/Credential Verification Service Chart']['credential-verification-service'];
  assert.equal(verifier.podAnnotations['inject.xfsc.io/needs'], 'nats,cassandra,signer,did-resolver,storageservice');
  assert.equal(verifier.config.storageServiceUrl, 'http://storage-service.ocm-wstack.svc.cluster.local:8080');
  assert.equal(verifier.ingress.enabled, false);
  assert.equal(verifier.config.externalPresentation.enabled, true);
});
