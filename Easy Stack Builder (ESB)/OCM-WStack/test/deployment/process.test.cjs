'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, workspace, bash } = require('./helpers.cjs');

test('lease renewal stops promptly when an operation finishes between renewals', t => {
  const dir = workspace(t);
  const started = Date.now();
  const result = bash(dir, `
get_optional() { printf null >"$1"; }
kube_json() { cp "$WORKDIR/lease-new.json" "$1"; }
acquire_lease
sleep 0.1
kill -TERM "$LEASE_PID"
wait "$LEASE_PID"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 3000);
});

test('Helm retries only API transport failures and rechecks lease and release before each write', t => {
  const dir = workspace(t);
  const result = bash(dir, `
sleep() { :; }
run_capture() {
  local output=$1; shift 2
  LAST_ERROR="$WORKDIR/last-error"; : >"$LAST_ERROR"; LAST_STATUS=0
  printf '%s\\n' "$*" >>"$WORKDIR/calls"
  case "$*" in
    'kubectl get --raw=/readyz --request-timeout=10s') printf ok >"$output" ;;
    'helm status release -n target -o json') printf '{"info":{"status":"deployed"}}' >"$output" ;;
    'kubectl -n kube-system get lease esb-ocmwstack-v12 -o json --request-timeout=10s')
      jq -n --arg now "$(timestamp)" '{spec:{holderIdentity:"ours",renewTime:$now,leaseDurationSeconds:180}}' >"$output" ;;
    'helm upgrade --install release chart -n target')
      if [[ ! -f $WORKDIR/attempted ]]; then touch "$WORKDIR/attempted"; printf 'Get "https://api.example/resource": EOF' >"$LAST_ERROR"; LAST_STATUS=1; return 1; fi ;;
    *) printf 'unexpected command: %s\\n' "$*" >&2; return 1 ;;
  esac
}
ESB_LEASE_HOLDER=ours
helm_upgrade target release upgrade --install release chart -n target
cat "$WORKDIR/calls"
`);
  assert.equal(result.status, 0, result.stderr);
  const calls = result.stdout.trim().split('\n');
  assert.equal(calls.filter(x => x.startsWith('helm upgrade')).length, 2);
  const writes = calls.flatMap((value, i) => value.startsWith('helm upgrade') ? [i] : []);
  for (const i of writes) {
    assert.match(calls[i - 1], /get lease/);
    assert.match(calls[i - 2], /^helm status/);
    assert.match(calls[i - 3], /readyz/);
  }
});

for (const [name, state, holder, message, expected, writes] of [
  ['pending release', 'pending-upgrade', 'ours', '', 'HELM_PENDING', 0],
  ['foreign lease', 'deployed', 'someone-else', '', 'LEASE_LOST', 0],
  ['permanent chart error', 'deployed', 'ours', 'template: unexpected EOF', 'COMMAND_FAILED', 1],
  ['denied write', 'deployed', 'ours', 'Forbidden private-secret-value', 'COMMAND_FAILED', 1],
]) {
  test(`${name} stops Helm without deleting release records`, t => {
    const dir = workspace(t);
    const result = bash(dir, `
sleep() { :; }
run_capture() {
  local output=$1; shift 2
  LAST_ERROR="$WORKDIR/last-error"; : >"$LAST_ERROR"; LAST_STATUS=0
  printf '%s\\n' "$*" >>"$WORKDIR/calls"
  case "$*" in
    'kubectl get --raw=/readyz --request-timeout=10s') printf ok >"$output" ;;
    'helm status release -n target -o json') jq -n --arg status "$TEST_STATE" '{info:{status:$status}}' >"$output" ;;
    'kubectl -n kube-system get lease esb-ocmwstack-v12 -o json --request-timeout=10s')
      jq -n --arg holder "$TEST_HOLDER" --arg now "$(timestamp)" '{spec:{holderIdentity:$holder,renewTime:$now,leaseDurationSeconds:180}}' >"$output" ;;
    'helm upgrade --install release chart -n target') printf '%s' "$TEST_ERROR" >"$LAST_ERROR"; LAST_STATUS=1; return 1 ;;
    *) return 1 ;;
  esac
}
ESB_LEASE_HOLDER=ours
helm_upgrade target release upgrade --install release chart -n target
`, { TEST_STATE: state, TEST_HOLDER: holder, TEST_ERROR: message });
    assert.notEqual(result.status, 0);
    const error = JSON.parse(fs.readFileSync(path.join(dir, 'error.json')));
    assert.equal(error.code, expected);
    assert.ok(!JSON.stringify(error).includes('private-secret-value'));
    const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8');
    assert.equal((calls.match(/helm upgrade/g) || []).length, writes);
    assert.ok(!/delete|uninstall|rollback/.test(calls));
  });
}

test('ownership validation rejects foreign namespaces before creating a marker', t => {
  const dir = workspace(t, { 'config.json': { instanceName: 'test', clusterUid: 'cluster', tenantId: 'demo', tenantRelease: 'demo', tenantHost: 'demo.example.com', actualStorageClass: 'default' } });
  const result = bash(dir, `
get_optional() { printf null >"$1"; }
kube_json() { [[ "$*" == *'get namespaces'* ]] || { touch "$WORKDIR/write"; return 1; }; printf '{"items":[{"metadata":{"name":"ocm-wstack"}}]}' >"$1"; }
ensure_marker
`);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'error.json'))).code, 'NOT_FRESH');
  assert.equal(fs.existsSync(path.join(dir, 'write')), false);
});

test('uploaded kubeconfig wrappers bind identity and reject override flags', t => {
  const dir = workspace(t, { kubeconfig: 'test' });
  const executable = path.join(dir, 'fake-kubectl');
  fs.writeFileSync(executable, '#!/bin/bash\nprintf \'%s\\n\' "$@"\n', { mode: 0o700 });
  const env = { ESB_KUBECONFIG: path.join(dir, 'kubeconfig'), ESB_KUBE_CONTEXT: 'uploaded', ESB_REAL_KUBECTL: executable, ESB_REAL_HELM: executable };
  let result = bash(dir, 'kube_command kubectl get pods -A', env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['--kubeconfig', env.ESB_KUBECONFIG, '--context', 'uploaded', 'get', 'pods', '-A']);
  for (const flag of ['--server=https://foreign', '--as=other', '--token=secret', '--context=other', '-shttps://foreign']) {
    result = bash(dir, 'kube_command kubectl "$OVERRIDE" get pods', { ...env, OVERRIDE: flag });
    assert.notEqual(result.status, 0);
  }
});

test('Argo forbidden list reads require both an identity recheck and a successful real read', t => {
  const dir = workspace(t);
  const result = bash(dir, `
sleep() { :; }
run_capture() {
  local output=$1
  LAST_ERROR="$WORKDIR/last-error"; LAST_STATUS=1
  printf Forbidden >"$LAST_ERROR"
  if [[ -f $WORKDIR/rechecked ]]; then printf '{"items":[]}' >"$output"; return 0; fi
  return 1
}
kube_identity() { printf identity >>"$WORKDIR/order"; }
access_review() { printf review >>"$WORKDIR/order"; touch "$WORKDIR/rechecked"; }
ESB_KUBE_USERNAME=uploaded
kube_read /apis/argoproj.io/v1alpha1/namespaces/argocd/applications false 60
`);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { items: [] });
  assert.equal(fs.readFileSync(path.join(dir, 'order'), 'utf8'), 'identityreview');
});

test('registry challenge requests only pull scope and keeps bearer data in private files', t => {
  const dir = workspace(t, { 'registry-headers': 'HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 401 Unauthorized\r\nWWW-Authenticate: Bearer realm="https://auth.example/token?account=bad&scope=push&existing=kept",service="registry.example",scope="repository:other:push"\r\n\r\n' });
  const result = bash(dir, `
registry_request() { printf '%s' "$2" >"$WORKDIR/token-url"; printf 200 >"$WORKDIR/registry-status"; printf '{"token":"private-bearer-token"}' >"$WORKDIR/registry-body"; }
registry_authenticate
cat "$WORKDIR/token-url"
`);
  assert.equal(result.status, 0, result.stderr);
  const url = new URL(result.stdout);
  assert.equal(url.searchParams.get('scope'), 'repository:tsa/policy:pull');
  assert.equal(url.searchParams.get('account'), null); assert.equal(url.searchParams.get('existing'), 'kept');
  assert.equal(fs.statSync(path.join(dir, 'registry-auth')).mode & 0o777, 0o600);
  assert.ok(!result.stdout.includes('private-bearer-token') && !result.stderr.includes('private-bearer-token'));
});

test('static upstream patch applies to checksum-verified fixtures and leaves executable Bash hooks', t => {
  const dir = workspace(t);
  fs.cpSync(path.join(ROOT, 'test/fixtures/upstream'), path.join(dir, 'source'), { recursive: true });
  const result = bash(dir, `
while IFS=$'\\t' read -r file expected; do
  actual=$(sha256sum "$WORKDIR/source/$file" | cut -d ' ' -f 1)
  [[ $actual == "$expected" ]]
done < <(jq -r '.sha256 | to_entries[] | [.key,.value] | @tsv' "$ROOT/upstream-lock.json")
git -C "$WORKDIR/source" apply --check "$DEPLOYMENT/upstream.patch"
git -C "$WORKDIR/source" apply "$DEPLOYMENT/upstream.patch"
for script in "$WORKDIR/source/"*.sh; do bash -n "$script"; done
`);
  assert.equal(result.status, 0, result.stderr);
  const bootstrap = fs.readFileSync(path.join(dir, 'source/basic-cluster-init.sh'), 'utf8');
  assert.ok(bootstrap.includes('--internal helm-upgrade'));
  assert.ok(!bootstrap.includes('node "${ESB_'));
});
