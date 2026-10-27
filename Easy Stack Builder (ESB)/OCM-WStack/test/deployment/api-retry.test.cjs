'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { workspace, bash } = require('./helpers.cjs');

const categories = [
  ['Client.Timeout exceeded while awaiting headers', 1, 'request-timeout', true],
  ['context deadline exceeded', 1, 'request-timeout', true],
  ['', 124, 'process-timeout', true],
  ['Error from server (Timeout): request exceeded deadline', 1, 'request-timeout', true],
  ['', 137, 'process-terminated', false],
  ['', 143, 'process-terminated', false],
  ['lookup api.example: no such host', 1, 'dns', true],
  ['dial tcp: connection reset by peer', 1, 'connection', true],
  ['Get "https://api.example:15778/readyz": EOF', 1, 'connection', true],
  ['Error from server (ServiceUnavailable)', 1, 'api-unavailable', true],
  ['Error from server (InternalError): readiness check failed', 1, 'api-unavailable', true],
  ['Error from server (TooManyRequests)', 1, 'rate-limited', true],
  ['Unauthorized: context deadline exceeded', 124, 'authentication', false],
  ['Forbidden: context deadline exceeded', 124, 'authorization', false],
  ['x509: certificate signed by unknown authority', 124, 'certificate', false],
  ['tls: failed to verify certificate', 1, 'certificate', false],
  ['Uploaded kubeconfig binding is unavailable.', 1, 'kubeconfig', false],
  ['template: unexpected EOF', 1, 'validation', false],
  ['another operation is in progress', 1, 'helm-pending', false],
  ['line 43: ESB_REAL_KUBECTL: unbound variable', 1, 'local-command', false],
  ['timeout: cannot execute command', 126, 'local-command', false],
  ['unfamiliar error private-value', 1, 'unclassified', false],
];
for (const [message, status, reason, retry] of categories) {
  test(`API failure ${reason}: ${message || 'empty timeout stderr'}`, t => {
    const dir = workspace(t, { 'failure': message });
    const r = bash(dir, `
api_failure_reason "$WORKDIR/failure" "$TEST_STATUS"
printf '\\n'
if transport_failure "$WORKDIR/failure" "$TEST_STATUS"; then printf retry; else printf stop; fi
`, { TEST_STATUS: String(status) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${reason}\n${retry ? 'retry' : 'stop'}`);
  });
}

// Exercise the actual timeout runner and credential/context wrapper. The fake
// kubectl has no network access and checks every invocation's supplied identity.
function scenario(t, readyResults, helmResults = [0], releaseState = 'deployed', advanceClock = false) {
  const dir = workspace(t, {
    'selection.json': { server: 'https://user:private-url-password@api.example:15778/path?private-query' },
    'kubeconfig': 'fixture-only',
  });
  const script = `#!/usr/bin/env bash
set -eu
[[ $1 == --kubeconfig && $2 == "$WORKDIR/kubeconfig" && $3 == --context && $4 == fixture-context ]]
shift 4
printf '%s\\n' "$*" >>"$WORKDIR/kube-calls"
case "$*" in
 'get --raw=/readyz --request-timeout=10s')
   i=$(cat "$WORKDIR/ready-count" 2>/dev/null || printf 0)
   i=$((i+1)); printf %s "$i" >"$WORKDIR/ready-count"
   case "$i" in
${readyResults.map((x, i) => `     ${i + 1}) printf '%s' '${x.message || ''}' >&2; printf '%s' '${x.body || ''}'; exit ${x.status} ;;`).join('\n')}
     *) printf ok ;;
   esac ;;
 *) exit 99 ;;
esac
`;
  fs.writeFileSync(dir + '/real-kubectl', script, { mode: 0o700 });
  fs.mkdirSync(dir + '/bin');
  fs.writeFileSync(dir + '/bin/kubectl', '#!/usr/bin/env bash\nexec bash "$ESB_DEPLOY" --internal kube-command kubectl "$@"\n', { mode: 0o700 });
  fs.writeFileSync(dir + '/bin/helm', `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >>"$WORKDIR/helm-calls"
case "$1" in
 status) printf '%s' '{"info":{"status":"${releaseState}"}}' ;;
 upgrade)
   i=$(cat "$WORKDIR/helm-count" 2>/dev/null || printf 0)
   i=$((i+1)); printf %s "$i" >"$WORKDIR/helm-count"
   case "$i" in
${helmResults.map((status, i) => `     ${i + 1}) ${status ? "printf 'context deadline exceeded private-response' >&2;" : ''} exit ${status} ;;`).join('\n')}
     *) exit 98 ;;
   esac ;;
 *) exit 97 ;;
esac
`, { mode: 0o700 });
  const r = bash(dir, `
export ESB_DEPLOY="$ROOT/deploy.sh" ESB_KUBECONFIG="$WORKDIR/kubeconfig"
export ESB_KUBE_CONTEXT=fixture-context ESB_REAL_KUBECTL="$WORKDIR/real-kubectl"
export PATH="$WORKDIR/bin:$PATH"
sleep() { printf '%s\\n' "$1" >>"$WORKDIR/delays"; ${advanceClock ? 'SECONDS=$((SECONDS+$1));' : ''} }
verify_lease() { printf 'lease\\n' >>"$WORKDIR/helm-calls"; }
helm_upgrade observability observability upgrade --install observability chart -n observability
`);
  const error = fs.existsSync(dir + '/error.json') ? JSON.parse(fs.readFileSync(dir + '/error.json')) : null;
  const events = fs.readFileSync(dir + '/events.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(!JSON.stringify({ error, events }).includes('private-'));
  return { dir, r, error, events };
}

test('readiness timeouts recover before Helm runs, with an explicit uploaded identity', t => {
  const { dir, r, events } = scenario(t, [
    { status: 124 },
    { status: 1, message: 'Client.Timeout exceeded while awaiting headers' },
    { status: 0, body: 'ok\n' },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(dir + '/ready-count', 'utf8'), '3');
  assert.equal(fs.readFileSync(dir + '/helm-count', 'utf8'), '1');
  assert.equal(fs.readFileSync(dir + '/delays', 'utf8'), '2\n4\n');
  const failures = events.filter(e => e.type === 'command-failure');
  assert.deepEqual(failures.map(e => e.diagnostic.reason), ['process-timeout', 'request-timeout']);
  assert.equal(failures[0].diagnostic.apiServer, 'https://api.example:15778');
  assert.equal(failures[0].diagnostic.path, '/readyz');
  assert.match(fs.readFileSync(dir + '/helm-calls', 'utf8'), /status.*\nlease\nupgrade/s);
});

test('a Helm failure remains in the final result when readiness fails during retry', t => {
  const { dir, r, error } = scenario(t, [{ status: 0, body: 'ok' }, ...Array(30).fill({ status: 124 })], [1]);
  assert.notEqual(r.status, 0);
  assert.equal(error.code, 'API_UNREADY');
  assert.match(error.message, /process-timeout.*check 30\/30/);
  assert.equal(error.diagnostics.history[0].step, 'helm-upgrade');
  assert.equal(error.diagnostics.history[0].reason, 'request-timeout');
  assert.equal(error.diagnostics.history.length, 20);
  assert.equal(fs.readFileSync(dir + '/helm-count', 'utf8'), '1');
  assert.equal(fs.readFileSync(dir + '/ready-count', 'utf8'), '31');
});

for (const message of ['x509: certificate expired', 'Unknown local error']) {
  test(`readiness stops immediately for ${message}`, t => {
    const { dir, r, error } = scenario(t, [{ status: 1, message }]);
    assert.notEqual(r.status, 0);
    assert.equal(error.diagnostics.history.length, 1);
    assert.equal(error.diagnostics.history[0].retryable, false);
    assert.equal(fs.existsSync(dir + '/helm-count'), false);
    assert.equal(fs.existsSync(dir + '/delays'), false);
  });
}

test('Helm writes are bounded at five and each retry checks readiness, release and lease', t => {
  const { dir, r, error } = scenario(t, [], [1, 1, 1, 1, 1]);
  assert.notEqual(r.status, 0);
  assert.equal(error.code, 'API_TRANSPORT');
  assert.equal(error.diagnostics.history.length, 5);
  assert.equal(fs.readFileSync(dir + '/helm-count', 'utf8'), '5');
  assert.equal(fs.readFileSync(dir + '/ready-count', 'utf8'), '5');
  assert.equal(fs.readFileSync(dir + '/delays', 'utf8'), '5\n15\n30\n30\n');
  const calls = fs.readFileSync(dir + '/helm-calls', 'utf8').trim().split('\n');
  for (let i = 0; i < calls.length; i++) if (calls[i].startsWith('upgrade')) {
    assert.equal(calls[i - 1], 'lease'); assert.match(calls[i - 2], /^status/);
  }
});

test('a pending Helm release is retained and never upgraded', t => {
  const { dir, r, error } = scenario(t, [], [0], 'pending-install');
  assert.notEqual(r.status, 0);
  assert.equal(error.code, 'HELM_PENDING');
  assert.equal(fs.existsSync(dir + '/helm-count'), false);
});

test('diagnose-api reports five classified samples without calling Helm', t => {
  const dir = workspace(t, { failure: 'context deadline exceeded private-response' });
  const r = bash(dir, `
sleep() { :; }
run_capture() { LAST_ERROR="$WORKDIR/failure"; return 124; }
diagnose_api
`);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.status, 'api-unreliable');
  assert.equal(result.checks.length, 5);
  assert.ok(result.checks.every(x => !x.ok && x.reason === 'process-timeout' && x.exitCode === 124));
  assert.ok(!r.stdout.includes('private-response'));
});


test('BusyBox signal exits at the command deadline are reported as retryable timeouts', t => {
  const dir = workspace(t);
  fs.mkdirSync(dir + '/deadline-bin');
  fs.writeFileSync(dir + '/deadline-bin/timeout', '#!/bin/bash\nsleep 1\nexit 143\n', { mode: 0o700 });
  const result = bash(dir, `
export PATH="$WORKDIR/deadline-bin:$PATH"
if run_capture "$WORKDIR/output" 1 sh -c true; then exit 99; fi
[[ $LAST_STATUS == 143 && $LAST_TIMEOUT == true ]]
api_failure_reason "$LAST_ERROR" "$LAST_STATUS"
transport_failure "$LAST_ERROR"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'process-timeout');
});

test('an early signal exit is retained as an interruption rather than a deadline', t => {
  const dir = workspace(t);
  fs.mkdirSync(dir + '/signal-bin');
  fs.writeFileSync(dir + '/signal-bin/timeout', '#!/bin/bash\nexit 143\n', { mode: 0o700 });
  const result = bash(dir, `
export PATH="$WORKDIR/signal-bin:$PATH"
if run_capture "$WORKDIR/output" 12 sh -c true; then exit 99; fi
[[ $LAST_STATUS == 143 && $LAST_TIMEOUT == false ]]
api_failure_reason "$LAST_ERROR" "$LAST_STATUS"
if transport_failure "$LAST_ERROR"; then exit 98; fi
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'process-terminated');
});

for (const message of ['Forbidden', 'Unauthorized']) {
  test(`readiness recovers from temporary ${message} with the uploaded identity`, t => {
    const { dir, r, events } = scenario(t, [
      { status: 1, message }, { status: 1, message: 'connection reset by peer' },
      { status: 0, body: 'ok' },
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(dir + '/ready-count', 'utf8'), '3');
    assert.equal(fs.readFileSync(dir + '/helm-count', 'utf8'), '1');
    const retries = events.filter(e => e.type === 'retry');
    assert.equal(retries.length, 2);
    assert.equal(retries[0].attempts, 30);
    assert.equal(retries[0].remainingSeconds, 300);
    assert.equal(events.find(e => e.type === 'command-failure').diagnostic.retryable, true);
  });
  test(`persistent ${message} exhausts the recovery window without a Helm write`, t => {
    const { dir, r, error, events } = scenario(t, Array(30).fill({status: 1, message}), [0], 'deployed', true);
    assert.notEqual(r.status, 0);
    assert.equal(error.code, 'API_UNREADY');
    assert.match(error.message, /recovery window exhausted after 300s/);
    assert.equal(fs.existsSync(dir + '/helm-count'), false);
    const delays = fs.readFileSync(dir + '/delays', 'utf8').trim().split('\n').map(Number);
    const paused = delays.reduce((a,b) => a+b, 0);
    assert.ok(paused > 270 && paused <= 300); // Probe execution also consumes the budget.
    assert.ok(delays.every(x => x <= 15));
    assert.ok(events.filter(e => e.type === 'retry').every(e => e.remainingSeconds > 0));
  });
}
