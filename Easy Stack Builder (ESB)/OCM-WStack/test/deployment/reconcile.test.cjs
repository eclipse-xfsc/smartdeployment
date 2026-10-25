'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { workspace, bash, jq } = require('./helpers.cjs');
const fixture = require('./fixtures/reconciler.json');

function run(t, mutate = () => {}, options = {}) {
  const f = structuredClone(fixture); mutate(f);
  const dir = workspace(t, Object.fromEntries(Object.entries({
    deployments: f.deployments, secrets: f.secrets, resourceclaims: f.claims,
    externalsecrets: f.externalSecrets, pods: f.pods, replicasets: f.replicasets,
    provider: f.provider, admin: f.admin, connections: f.connections,
  }).map(([name, data]) => [`fixture-${name}.json`, data])));
  const result = bash(dir, `
source "$DEPLOYMENT/reconcile.sh"
STATE_DIR="$WORKDIR"
secret_reads=0
api_list() {
  cp "$WORKDIR/fixture-$1.json" "$2"
  if [[ $1 == secrets ]]; then
    secret_reads=$((secret_reads+1))
    if [[ \${ROTATE_DURING:-false} == true && $secret_reads == 2 ]]; then
      jq '.[0].data.password="cm90YXRlZA=="' "$2" >"$WORKDIR/late-secrets.json"
      mv "$WORKDIR/late-secrets.json" "$2"
    fi
  fi
}
api_request() {
  case "$2" in
    */resourceproviders/redis) cp "$WORKDIR/fixture-provider.json" "$3" ;;
    */secrets/redis-root-auth) cp "$WORKDIR/fixture-admin.json" "$3" ;;
    *) return 1 ;;
  esac
}
timeout() {
  case " $* " in
    *' --redis '*)
      [[ \${DENY_REDIS:-false} != true ]] || { guard_error REDIS_COMMAND; return 1; }
      printf '{"authenticated":true,"changed":false}' >"$STATE_DIR/redis-status.json" ;;
    *' --nats '*)
      printf 'ping\\n' >>"$WORKDIR/nats-checks"
      [[ \${DENY_NATS:-false} != true ]] || { guard_error NATS_UNAVAILABLE; return 1; } ;;
    *) return 1 ;;
  esac
}
nats_connections() { cp "$WORKDIR/fixture-connections.json" "$STATE_DIR/connections.json"; }
annotate_deployment() { jq -cn --slurpfile d "$1" --slurpfile a "$2" '{name:$d[0].metadata.name,annotations:$a[0]}' >>"$WORKDIR/writes.jsonl"; }
reconcile_once
cat "$STATE_DIR/result.json"
`, options);
  const writes = fs.existsSync(path.join(dir, 'writes.jsonl')) ? fs.readFileSync(path.join(dir, 'writes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { ...result, dir, writes, report: result.status === 0 ? JSON.parse(result.stdout) : null };
}

test('a synchronized native stack produces a ready report without writes', t => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.report.ready, true);
  assert.equal(result.writes.length, 0);
});
test('credential rotation verifies Redis and changes only the consuming deployment annotation', t => {
  const result = run(t, f => { f.secrets[0].data.password = Buffer.from('new-private-password').toString('base64'); });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.report.ready, false);
  assert.equal(result.writes.length, 1); assert.equal(result.writes[0].name, 'pre-authorization-bridge');
  assert.deepEqual(Object.keys(result.writes[0].annotations), ['esb.xfsc.io/credentials']);
  assert.ok(!result.stdout.includes('new-private-password'));
});
test('rejected Redis authentication prevents every deployment write', t => {
  const result = run(t, f => { f.secrets[0].data.password = Buffer.from('rotated').toString('base64'); }, { DENY_REDIS: 'true' });
  assert.notEqual(result.status, 0); assert.equal(result.writes.length, 0);
});
test('a Secret changed during reconciliation prevents a ready result', t => {
  const result = run(t, undefined, { ROTATE_DURING: 'true' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.report.ready, false);
  assert.equal(result.report.credentials.synchronized, false);
});
test('initial Retrieval migration finishes before its first credential reload', t => {
  const result = run(t, f => {
    const retrieval = structuredClone(f.deployments[0]);
    retrieval.metadata.name = 'credential-retrieval-service';
    retrieval.spec.template.metadata.annotations = {}; retrieval.status.readyReplicas = 0;
    f.deployments.push(retrieval);
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.report.ready, false); assert.equal(result.writes.length, 0);
});
test('missing Well-Known listeners require reachable NATS before a bounded restart', t => {
  const mutate = f => { f.connections[1].subscriptions_list = ['wellknown.issuer.metadata']; };
  let result = run(t, mutate, { DENY_NATS: 'true' });
  assert.notEqual(result.status, 0); assert.equal(result.writes.length, 0);
  result = run(t, mutate);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.report.ready, false);
  assert.equal(result.writes.length, 1); assert.equal(result.writes[0].name, 'well-known-service');
  result = run(t, f => {
    mutate(f); f.deployments[1].spec.template.metadata.annotations['esb.xfsc.io/nats-recovery'] = new Date().toISOString();
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.writes.length, 0);
});
test('stale reports, changed pods, or incomplete listener claims cannot satisfy inspection', t => {
  const result = run(t); assert.equal(result.status, 0, result.stderr);
  const verify = (report, f) => jq('validate_guard_status($deployments;$pods;$replicasets;$now)', report,
    { ...f, now: Math.floor(Date.now() / 1000) });
  assert.equal(verify(result.report, fixture).ready, true);
  for (const mutate of [
    (r, f) => { r.checkedAt = new Date(Date.now() - 61000).toISOString(); },
    (r, f) => { r.redis.authenticated = false; },
    (r, f) => { r.services[1].subjects = []; },
    (r, f) => { f.pods[0].metadata.uid = 'new-pod'; },
    (r, f) => { f.pods[0].metadata.annotations['esb.xfsc.io/credentials'] = 'stale'; },
    (r, f) => { f.pods[0].spec.containers[0].image = 'other:tag'; },
  ]) {
    const report = structuredClone(result.report), f = structuredClone(fixture); mutate(report, f);
    assert.equal(verify(report, f).ready, false);
  }
});
