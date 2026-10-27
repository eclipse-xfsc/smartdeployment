'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, workspace } = require('./helpers.cjs');

function node(t, script, config = {}) {
  const dir = workspace(t);
  fs.copyFileSync(path.join(ROOT, 'ocmwstack.js'), path.join(dir, 'ocmwstack.cjs'));
  fs.writeFileSync(path.join(dir, 'deploy.sh'), script);
  const handlers = {}, messages = [], statuses = [];
  const settings = { userDir: dir };
  let Constructor, credentials;
  require(path.join(dir, 'ocmwstack.cjs'))({ settings, nodes: {
    registerType(name, constructor, options) { assert.equal(name, 'OCM-W-Stack'); Constructor = constructor; credentials = options.credentials; },
    createNode(instance) {
      instance.on = (event, handler) => { handlers[event] = handler; };
      instance.status = status => statuses.push(status);
      instance.send = message => messages.push(message);
      instance.error = () => {};
      instance.credentials = { kubeconfig: 'private-config', editorPassword: 'private-password' };
    },
  } });
  new Constructor({ procedureVersion: 12, domainAddress: 'configured.example', ...config });
  return { dir, handlers, messages, statuses, credentials,
    input: message => new Promise(resolve => handlers.input(message, value => messages.push(value), resolve)),
    close: () => new Promise(resolve => handlers.close(false, resolve)),
  };
}

test('the next trigger reconstructs an interrupted run from persistent logs',async t=>{
 const n=node(t,'#!/bin/bash\nprintf \'{"status":"ready"}\'');
 const dir=path.join(n.dir,'ocm-deployer-logs','previous-run');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify({nodeId:'ocm-deployer',state:'running',action:'deploy',
  host:'previous-container',pid:999999,startedAt:'2026-10-27T00:00:00Z',access:{urls:{tenant:'https://example.invalid'}}}));
 fs.writeFileSync(path.join(dir,'script.stderr'),'retained interruption evidence\n');
 assert.equal(await n.input({action:'deploy'}),undefined);
 const recovered=n.messages.find(m=>m[2]?.recovered)?.[2];assert.ok(recovered);
 assert.equal(recovered.complete,false);assert.match(recovered.payload,/retained interruption evidence/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'run.json'))).state,'interrupted');
 assert.equal(n.messages.at(-1)[0].payload.status,'ready');await n.close();
});

test('configured persistent log directory receives the complete result and raw log',async t=>{
 const logRoot=workspace(t),n=node(t,'#!/bin/bash\nprintf \'{"status":"ready"}\'',{logDirectory:logRoot});
 assert.equal(await n.input({action:'deploy'}),undefined);
 const log=n.messages.at(-1)[2];assert.ok(log.filename.startsWith(logRoot+'/'));
 const run=JSON.parse(fs.readFileSync(path.join(path.dirname(log.filename),'run.json')));
 assert.equal(run.state,'finished');assert.equal(run.result.status,'ready');await n.close();
});

test('node keeps configuration and credentials private and preserves the two output topics', async t => {
  const n = node(t, `#!/bin/bash
set -euo pipefail
config=$3
credentials=$5
[[ $(stat -c %a "$config") == 600 && $(stat -c %a "$credentials") == 600 ]]
[[ $(stat -c %a "$(dirname "$config")") == 700 ]]
jq -e '.domainAddress=="configured.example" and .confirm=="explicit confirmation"' "$config" >/dev/null
jq -e '.kubeconfig=="private-config"' "$credentials" >/dev/null
printf '%s' "$(dirname "$config")" >"$(dirname "$0")/private-directory"
printf '{"type":"phase","phase":"preflight"}\\n' >&2
printf 'private raw diagnostic\\n' >&2
printf '{"status":"ready","tenantId":"demo"}\\n'
`);
  assert.equal(await n.input({ _msgid: 'message-id', action: 'preflight', confirm: 'explicit confirmation', domainAddress: 'untrusted.example', credentials: { kubeconfig: 'untrusted' } }), undefined);
  assert.equal(n.messages.length, 2);
  assert.equal(n.messages[0][1].topic, 'ocm-wstack/progress');
  assert.equal(n.messages[1][0].topic, 'ocm-wstack/result');
  assert.equal(n.messages[1][0].payload.status, 'ready');
  assert.equal(n.messages[1][0]._msgid, 'message-id');
  assert.equal(fs.existsSync(fs.readFileSync(path.join(n.dir, 'private-directory'), 'utf8')), false);
  assert.ok(!JSON.stringify(n.messages.map(m => m.slice(0, 2))).includes('private'));
  assert.match(n.messages.at(-1)[2].payload, /private raw diagnostic/);
  assert.equal(n.messages.at(-1)[2].topic, 'ocm-wstack/log');
  assert.equal(fs.readFileSync(n.messages.at(-1)[2].filename, 'utf8'), n.messages.at(-1)[2].payload);
  assert.equal(n.credentials.kubeconfig.type, 'password');
  await n.close();
});

test('a failed lifecycle report remains a complete result with its checks', async t => {
  const n = node(t, '#!/bin/bash\nprintf \'{"status":"failed","checks":[{"name":"storage-read-back","ok":false}]}\\n\'\nexit 2\n');
  assert.equal(await n.input({ action: 'test-credentials' }), undefined);
  assert.equal(n.messages[0][0].payload.checks[0].name, 'storage-read-back');
  await n.close();
});

test('coded deployment errors reach the result output and Node-RED error handling', async t => {
  const n = node(t, '#!/bin/bash\nprintf \'{"status":"failed","code":"OWNERSHIP","message":"Installation belongs to another tenant."}\\n\'\nexit 1\n');
  const error = await n.input({ action: 'deploy' });
  assert.equal(error.code, 'OWNERSHIP');
  assert.equal(n.messages[0][0].payload.code, 'OWNERSHIP');
  await n.close();
});

test('unknown actions do not invoke Bash', async t => {
  const n = node(t, '#!/bin/bash\ntouch "$(dirname "$0")/executed"\n');
  const error = await n.input({ action: '--internal' });
  assert.equal(error.code, 'ACTION'); assert.equal(fs.existsSync(path.join(n.dir, 'executed')), false);
  const next = await n.input({ action: 'preflight' });
  assert.equal(next.code, 'RESULT_FORMAT');
  assert.equal(fs.existsSync(path.join(n.dir, 'executed')), true);
  await n.close();
});

test('node close cancels the process group, waits for completion and blocks concurrent actions', async t => {
  const n = node(t, `#!/bin/bash
trap 'wait; exit 0' TERM
cat >"$(dirname "$0")/child.sh" <<'CHILD'
trap 'printf stopped >"$(dirname "$0")/child-stopped"; exit 0' TERM
printf started >"$(dirname "$0")/child-started"
sleep 300 &
wait
CHILD
bash "$(dirname "$0")/child.sh" &
wait
`);
  const operation = n.input({ action: 'deploy' });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(path.join(n.dir, 'child-started')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(path.join(n.dir, 'child-started')));
  const busy = await n.input({ action: 'inspect' });
  assert.match(busy.message, /already running/);
  await n.close();
  assert.equal((await operation).code, 'CANCELLED');
  assert.equal(fs.readFileSync(path.join(n.dir, 'child-stopped'), 'utf8'), 'stopped');
  assert.equal(n.messages.length, 0);
});

test('editor field defaults, encrypted credentials and output definitions remain compatible', () => {
  const source = fs.readFileSync(path.join(ROOT, 'ocmwstack.html'), 'utf8');
  let definition;
  vm.runInNewContext(source.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1], {
    RED: { nodes: { registerType: (name, spec) => { assert.equal(name, 'OCM-W-Stack'); definition = spec; } } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(definition)), require('./fixtures/editor.json'));
  assert.equal(definition.defaults.dnsValues.validate('[]'), false);
  assert.equal(definition.defaults.dnsValues.validate('{}'), true);
  assert.equal(definition.defaults.timeoutSeconds.validate(60), true);
  assert.equal(definition.defaults.timeoutSeconds.validate(59), false);
});

test('node recovers the original failure from its private result file',async t=>{
  const n=node(t,`#!/bin/bash
printf '{"status":"failed","code":"ARGO_SYNC_TIMEOUT","message":"Verification did not synchronize."}' >"$ESB_RESULT_FILE"
printf 'incomplete output'
exit 1
`);
  await n.input({action:'deploy'});
  const result=n.messages.at(-1)[0].payload;
  assert.equal(result.code,'ARGO_SYNC_TIMEOUT');
  assert.equal(result.message,'Verification did not synchronize.');
  await n.close();
});
test('node reports a terminated script and the last phase without exposing raw stderr',async t=>{
  const n=node(t,`#!/bin/bash
printf '{"type":"phase","phase":"native-validation"}\\n' >&2
printf 'private diagnostic' >&2
kill -KILL $$
`);
  await n.input({action:'deploy'});
  const result=n.messages.at(-1)[0].payload;
  assert.equal(result.code,'SCRIPT_TERMINATED');
  assert.match(result.message,/native-validation.*SIGKILL/);
  assert.ok(!JSON.stringify(n.messages.map(m => m.slice(0, 2))).includes('private diagnostic'));
  assert.match(n.messages.at(-1)[2].payload, /private diagnostic/);
  await n.close();
});

test('every node message includes URLs and current DNS records, including failures',async t=>{
 const n=node(t,`#!/bin/bash
printf '%s\n' '{"type":"phase","phase":"preflight"}' >&2
printf '%s\n' '{"type":"public-access","gatewayAddresses":[{"type":"IPAddress","value":"192.0.2.10"},{"type":"IPAddress","value":"2001:db8::10"}]}' >&2
printf '%s\n' '{"type":"phase","phase":"native-validation"}' >&2
printf '%s\n' '{"status":"failed","code":"FIXTURE","message":"fixture failure"}'
exit 1
`,{tenantSubdomain:'ocm',publicDashboards:true});
 await n.input({});
 const payloads=n.messages.flatMap(m => m.slice(0, 2)).filter(Boolean).map(m=>m.payload);
 assert.ok(payloads.length>=4);
 assert.equal(payloads[0].access.dns.status,'pending');
 for(const p of payloads) assert.equal(p.access.urls.ui,'https://ocm.configured.example/orce/');
 for(const p of payloads.slice(1)) {
  assert.equal(p.access.dns.status,'discovered');
  assert.equal(p.access.dns.records.length,6);
  assert.deepEqual(p.access.dns.targets,['192.0.2.10','2001:db8::10']);
 }
 assert.equal(payloads.at(-1).code,'FIXTURE');
});

test('final node output maps hostname targets to CNAME and omits disabled dashboards',async t=>{
 const n=node(t,`#!/bin/bash
printf '%s\n' '{"status":"ready","gatewayAddresses":[{"type":"Hostname","value":"lb.example.net"}]}'
`);
 await n.input({});const p=n.messages.flatMap(m => m.slice(0, 2)).filter(Boolean).at(-1).payload;
 assert.equal(p.access.urls.argocd,undefined);
 assert.deepEqual(p.access.dns.records,[{name:'demo-tenant.configured.example',type:'CNAME',value:'lb.example.net'}]);
});

test('API failures retain retry history and public access details in the final result', async t => {
  const diagnostics = { history: [
    { step: 'helm-upgrade', reason: 'connection', exitCode: 1, attempt: 1 },
    { step: 'api-readiness', reason: 'process-timeout', exitCode: 124, attempt: 5 },
  ] };
  const n = node(t, `#!/bin/bash
printf '%s' '${JSON.stringify({ status: 'failed', code: 'API_UNREADY', message: 'Readiness timed out.', diagnostics })}'
exit 1
`);
  const error = await n.input({ action: 'deploy' });
  assert.equal(error.code, 'API_UNREADY');
  const result = n.messages.at(-1)[0].payload;
  assert.deepEqual(result.diagnostics, diagnostics);
  assert.equal(result.access.urls.tenant, 'https://demo-tenant.configured.example');
  await n.close();
});

test('full log includes command output, failure status and retained private files', async t => {
  const n = node(t, `#!/bin/bash
set -Eeuo pipefail
WORKDIR=$(dirname "$3")
exec 3>&2
source '${path.join(ROOT, 'deployment/common.sh')}'
phase installing-fixture
run_capture "$WORKDIR/output" 5 bash -c 'printf "raw stdout marker\\n"; printf "raw stderr marker\\n" >&2; exit 7' || true
printf '{"status":"failed","code":"FIXTURE","message":"fixture failed"}'
exit 1
`);
  await n.input({ action: 'deploy' });
  const [result, , log] = n.messages.at(-1);
  assert.equal(result.payload.code, 'FIXTURE');
  assert.equal(log.status, 'failed');
  assert.equal(log.complete, true);
  for (const text of ['raw stdout marker', 'raw stderr marker', '"exitCode":7', 'installing-fixture', 'Final result']) assert.ok(log.payload.includes(text), text);
  assert.equal(fs.statSync(log.filename).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(log.filename)).mode & 0o777, 0o700);
  assert.ok(n.messages.some(m => m[1]?.payload.type === 'command-start'));
  assert.ok(n.messages.some(m => m[1]?.payload.type === 'command-end' && m[1].payload.exitCode === 7));
  assert.equal(fs.readFileSync(log.filename, 'utf8'), log.payload);
  await n.close();
});

test('full log does not truncate stderr larger than the result size limit', async t => {
  const n = node(t, `#!/bin/bash
node -e 'process.stderr.write("x".repeat(9*1024*1024)+"END-OF-LARGE-LOG\\n")'
printf '{"status":"ready"}'
`);
  assert.equal(await n.input({}), undefined);
  const log = n.messages.at(-1)[2];
  assert.ok(log.payload.length > 9 * 1024 * 1024);
  assert.ok(log.payload.includes('END-OF-LARGE-LOG'));
  assert.equal(log.status, 'ready');
  await n.close();
});

test('full log survives forced termination with an unfinished command', async t => {
  const n = node(t, `#!/bin/bash
mkdir "$ESB_LOG_DIR/command.fixture"
printf 'partial command output\\n' >"$ESB_LOG_DIR/command.fixture/stdout"
kill -KILL $$
`);
  await n.input({});
  const log = n.messages.at(-1)[2];
  assert.match(log.payload, /partial command output/);
  assert.match(log.payload, /completion was not recorded/);
  assert.match(log.payload, /SCRIPT_TERMINATED/);
  await n.close();
});

test('long operations emit a heartbeat without changing the result or access details', async t => {
  const n = node(t, `#!/bin/bash
printf '{"type":"phase","phase":"waiting-for-fixture"}\\n' >&2
sleep 11
printf '{"status":"ready"}'
`);
  await n.input({});
  const heartbeat = n.messages.find(m => m[1]?.payload.type === 'heartbeat')?.[1].payload;
  assert.equal(heartbeat.phase, 'waiting-for-fixture');
  assert.ok(heartbeat.elapsedSeconds >= 10);
  assert.ok(heartbeat.access.urls.ui);
  assert.match(n.messages.at(-1)[2].payload, /heartbeat/);
  await n.close();
});
