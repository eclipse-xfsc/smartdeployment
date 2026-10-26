'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { jq } = require('./helpers.cjs');

function healthy() {
  return {
    c: { tenantHost: 'demo.example.com', tenantUrl: 'https://demo.example.com', internalGatewayRouting: true,
      actualProvider: 'ionos', externalTrafficPolicy: 'Cluster', useExternalMongo: false },
    apps: { items: ['storage', 'network', 'core', 'ocm-wstack'].map(name => ({ metadata: { name,
      ownerReferences: [{ kind: 'ApplicationSet', name }] }, status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } } })) },
    pods: { items: ['ocm-orce', 'ocm-ui-mongodb'].map(name => ({ metadata: { name, namespace: 'ocm-wstack', labels: { app: name } },
      spec: { hostAliases: [{ ip: '10.0.0.10', hostnames: ['demo.example.com'] }] },
      status: { phase: 'Running', containerStatuses: [{ name, ready: true }] } })) },
    pvcs: { items: [] }, jobs: { items: [] }, gateway: { status: { addresses: [{ type: 'IPAddress', value: '203.0.113.1' }] } },
    cert: { type: 'kubernetes.io/tls', data: { 'tls.crt': 'certificate', 'tls.key': 'key' } },
    proxy: { spec: { provider: { kubernetes: { envoyService: { externalTrafficPolicy: 'Cluster', annotations: {} } } } } },
    policy: { status: { conditions: [{ type: 'Ready', status: 'True' }] } },
    services: { items: [{ metadata: { name: 'envoy' }, spec: { clusterIP: '10.0.0.10', type: 'LoadBalancer',
      externalTrafficPolicy: 'Cluster', ports: [{ port: 80 }, { port: 443 }] } }] },
    operational: { ready: true }, lock: {},
  };
}

function inspect(input) {
  return jq('inspect_report(.c;.lock;.apps;.pods;.pvcs;.jobs;.gateway;.cert;.proxy;.policy;.services;.operational)', input);
}

test('cluster readiness follows the ORCE and MongoDB deployment', () => {
  const input = healthy();
  assert.equal(inspect(input).clusterReady, true);
  assert.equal(inspect(input).gatewayConfigurationReady, true);
  input.pods.items.pop();
  assert.equal(inspect(input).clusterReady, false);
  input.c.useExternalMongo = true;
  assert.equal(inspect(input).clusterReady, true);
  input.pods.items[0].status.containerStatuses[0].ready = false;
  assert.equal(inspect(input).clusterReady, false);
});

test('inspection retains gateway, ownership, reconciler, volume and failed-job checks', () => {
  for (const change of [
    i => { i.operational.ready = false; },
    i => { i.apps.items.pop(); },
    i => { i.apps.items[0].status.health.status = 'Degraded'; },
    i => { i.pvcs.items.push({ metadata: { name: 'data', namespace: 'ocm-wstack' }, status: { phase: 'Pending' } }); },
    i => { i.jobs.items.push({ metadata: { name: 'migration', namespace: 'ocm-wstack' }, status: { conditions: [{ type: 'Failed', status: 'True' }] } }); },
  ]) {
    const input = healthy(); change(input);
    assert.equal(inspect(input).clusterReady, false);
  }
  const input = healthy(); input.services.items[0].spec.ports.pop();
  assert.equal(inspect(input).gatewayConfigurationReady, false);
  input.cert = null;
  assert.equal(inspect(input).certificateReady, false);
});

test('healthy Verification drift is reported and does not block final readiness',()=>{
  const input=healthy();input.apps.items.push({metadata:{name:'credential-verification-service-chart',ownerReferences:[{kind:'ApplicationSet',name:'ocm-wstack'}]},status:{sync:{status:'OutOfSync'},health:{status:'Healthy'}}});
  let report=inspect(input);assert.equal(report.clusterReady,true);assert.equal(report.acceptedSyncDifferences.length,1);assert.equal(report.applications.at(-1).sync,'OutOfSync');
  input.apps.items.at(-1).status.health.status='Degraded';assert.equal(inspect(input).clusterReady,false);
  input.apps.items.at(-1).status.health.status='Healthy';input.apps.items.at(-1).metadata.name='storage-service';assert.equal(inspect(input).clusterReady,false);
});
