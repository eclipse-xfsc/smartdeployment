'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ROOT, workspace, bash } = require('./helpers.cjs');

function execute(t, action, { bootstrapped = false, result = 'ready', confirm = '', owner = true } = {}) {
  const dir = workspace(t, { 'input.json': {
    procedureVersion: 12, domain: 'example.com', email: 'admin@example.com',
    runtimeImage: 'example.com/runtime:12.4.0',
  } });
  const response = bash(dir, `
source "$ROOT/deploy.sh"
trace() { printf '%s\\n' "$*" >> "$TRACE"; }
check_tools() { printf '{}\\n'; }
bind_kubeconfig() { trace bind; }
kube_identity() { trace identity; printf '{"status":{"userInfo":{"username":"operator"}}}' >"$WORKDIR/identity.json"; printf '{}' >"$WORKDIR/selection.json"; }
cluster_preflight() { trace cluster; update_config '.actualStorageClass="storage" | .profile="generic"'; }
tls_preflight() { trace tls-preflight; }
runtime_preflight() { trace runtime-preflight; }
checkout_source() { trace source; SOURCE="$WORKDIR/source"; mkdir -p "$SOURCE"; }
prepare_charts() { trace charts; printf '{"status":"preflight-passed","argoRevision":"revision","charts":[],"argoManifestSha256":"hash"}' >"$WORKDIR/chart-report.json"; }
marker_matches() { trace ownership; [[ $OWNER == true ]]; }
acquire_lease() { trace acquire; export ESB_LEASE_HOLDER=operator; }
release_lease() { trace release; }
verify_lease() { trace verify; }
ensure_marker() { trace marker; printf '{"data":{"bootstrapComplete":"%s"}}' "$BOOTSTRAPPED" >"$WORKDIR/marker.json"; }
update_marker() { trace update-marker; }
write_values() { trace values; ESB_DNS_SECRET_FILE=''; }
permit_dns_repository() { trace dns-repository; }
gateway_policy() { trace gateway-policy; }
install_application_set() { trace install-set "$1"; }
wait_application_set() { trace wait-set "$1"; }
gateway_reconcile() { trace gateway; }
release_status() { trace release-status; printf deployed; }
native_prerequisites() { trace prerequisites; }
native_startup() { trace startup; }
native_routing() { trace routing; }
tls_install() { trace tls-install; }
wait_tenant_tls() { trace wait-tls; }
runtime_install() { trace runtime; }
dashboard_install() { trace dashboards; }
helm_upgrade() { trace helm "$1" "$2"; }
run() { trace command "$2"; }
inspect_stack() { trace inspect; printf '{"status":"inspected"}'; }
validate_stack() { trace validate; printf '{"status":"%s","ui":{"checks":[]}}' "$RESULT"; }
wait_validation() { validate_stack; }
diagnose_api() { trace api; printf '{"status":"api-reachable"}'; }
storage_diagnostics() { trace storage; printf '{"status":"diagnosed"}'; }
main "$ACTION" --config "$INPUT" --confirm "$CONFIRMATION"
`, { TRACE: dir + '/trace', INPUT: dir + '/input.json', ACTION: action, BOOTSTRAPPED: String(bootstrapped),
    OWNER: String(owner), RESULT: result, CONFIRMATION: confirm, TMPDIR: dir });
  const calls = fs.existsSync(dir + '/trace') ? fs.readFileSync(dir + '/trace', 'utf8').trim().split('\n') : [];
  assert.equal(fs.readdirSync(dir).some(name => name.startsWith('esb-ocmwstack.')), false, 'Private operation directory is removed');
  return { ...response, data: JSON.parse(response.stdout), calls };
}

test('preflight validates sources and charts without acquiring a mutation lease', t => {
  const r = execute(t, 'preflight');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.data.status, 'preflight-passed');
  assert.deepEqual(r.calls, ['bind', 'identity', 'cluster', 'tls-preflight', 'runtime-preflight', 'source', 'charts']);
});

test('fresh deployment bootstraps once, installs the tenant and runtime, then validates', t => {
  const r = execute(t, 'deploy');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.data.status, 'ready');
  assert.equal(r.calls.filter(call => call === 'command bash').length, 1);
  assert.ok(r.calls.indexOf('acquire') < r.calls.indexOf('command bash'));
  assert.ok(r.calls.indexOf('command bash') < r.calls.indexOf('helm ocm-wstack demotenant'));
  assert.ok(r.calls.indexOf('wait-tls') < r.calls.indexOf('runtime'));
  assert.ok(r.calls.indexOf('runtime') < r.calls.indexOf('validate'));
  assert.equal(r.calls.at(-1), 'release');
});

test('resumed deployment reconciles shared and native services without repeating bootstrap', t => {
  const r = execute(t, 'deploy', { bootstrapped: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.includes('command bash'), false);
  for (const set of ['network', 'storage', 'core', 'ocm-wstack']) assert.ok(r.calls.includes('install-set ' + set));
  assert.ok(r.calls.indexOf('prerequisites') < r.calls.indexOf('install-set ocm-wstack'));
  assert.ok(r.calls.indexOf('startup') < r.calls.indexOf('runtime'));
});

test('network repair finishes after gateway reconciliation and UI installation preserves native services', t => {
  const network = execute(t, 'repair-network', { bootstrapped: true });
  assert.equal(network.status, 0, network.stderr);
  assert.equal(network.calls.includes('runtime-preflight'), false);
  assert.equal(network.calls.includes('runtime'), false);
  assert.equal(network.calls.includes('install-set ocm-wstack'), false);
  const ui = execute(t, 'install-ui', { bootstrapped: true });
  assert.equal(ui.status, 0, ui.stderr);
  assert.ok(ui.calls.includes('runtime'));
  assert.equal(ui.calls.some(call => call.startsWith('install-set ')), false);
});

test('ownership and bootstrap checks prevent targeted mutation on an unrelated installation', t => {
  const foreign = execute(t, 'repair-ocm', { owner: false });
  assert.notEqual(foreign.status, 0);
  assert.equal(foreign.data.code, 'OWNERSHIP');
  assert.equal(foreign.calls.includes('acquire'), false);
  const incomplete = execute(t, 'install-ui');
  assert.notEqual(incomplete.status, 0);
  assert.equal(incomplete.data.code, 'OWNERSHIP');
  assert.equal(incomplete.calls.includes('runtime'), false);
  assert.equal(incomplete.calls.at(-1), 'release');
});

test('read actions do not enter chart preparation or acquire a deployment lease', t => {
  for (const action of ['inspect', 'validate', 'diagnose-api', 'diagnose-auth', 'diagnose-storage']) {
    const r = execute(t, action);
    assert.equal(r.status, 0, action + ': ' + r.stderr);
    assert.equal(r.calls.includes('charts'), false);
    assert.equal(r.calls.includes('acquire'), false);
  }
});

test('teardown requires exact confirmation and removes only the tenant release', t => {
  const denied = execute(t, 'teardown');
  assert.notEqual(denied.status, 0);
  assert.equal(denied.data.code, 'CONFIRM');
  assert.equal(denied.calls.includes('acquire'), false);
  const accepted = execute(t, 'teardown', { confirm: 'REMOVE TENANT demotenant' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.data.status, 'tenant-removed');
  assert.deepEqual(accepted.calls.filter(call => call.startsWith('command ')), ['command helm']);
});

test('an incomplete readiness result retains its JSON report and exits with status 2', t => {
  const r = execute(t, 'deploy', { result: 'action-required' });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.data.status, 'action-required');
  assert.equal(r.calls.at(-1), 'release');
});
