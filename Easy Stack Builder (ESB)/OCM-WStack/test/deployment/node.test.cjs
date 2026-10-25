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
  let Constructor, credentials;
  require(path.join(dir, 'ocmwstack.cjs'))({ nodes: {
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
  assert.ok(!JSON.stringify(n.messages).includes('private'));
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
sleep 300 &
printf '%s' "$!" >"$(dirname "$0")/child-pid.tmp"
mv "$(dirname "$0")/child-pid.tmp" "$(dirname "$0")/child-pid"
wait
`);
  const operation = n.input({ action: 'deploy' });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(path.join(n.dir, 'child-pid')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(path.join(n.dir, 'child-pid')));
  const busy = await n.input({ action: 'inspect' });
  assert.match(busy.message, /already running/);
  await n.close();
  assert.equal((await operation).code, 'CANCELLED');
  const pid = fs.readFileSync(path.join(n.dir, 'child-pid'), 'utf8');
  if (fs.existsSync(`/proc/${pid}/stat`)) assert.match(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), /\) Z /);
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
