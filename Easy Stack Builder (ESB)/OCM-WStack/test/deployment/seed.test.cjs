'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, workspace, jq, bash } = require('./helpers.cjs');

function setup(t) {
  const dir = workspace(t);
  for (const name of ['seed','data','bin']) fs.mkdirSync(path.join(dir,name));
  for (const name of ['seed.sh','runtime.tgz','ui.tgz']) fs.copyFileSync(path.join(ROOT,'charts-runtime/files',name),path.join(dir,'seed',name));
  fs.writeFileSync(dir+'/bin/npm', `#!/bin/sh
set -eu
printf '%s:%s\\n' "$(basename "$PWD")" "$*" >>"$OCM_DATA_DIR/npm-calls"
if [ "$1" = run ]; then
  [ "\${FAIL_BUILD:-}" != yes ] || exit 19
  mkdir -p ../runtime/uibuilder/orce/dist/.vite
  printf '<html>compiled UI</html>' > ../runtime/uibuilder/orce/dist/index.html
  printf '{"index.html":{"file":"assets/main.js"}}' > ../runtime/uibuilder/orce/dist/.vite/manifest.json
else
  for package in bcryptjs mongodb nats node-red-contrib-uibuilder vue qrcode; do
    mkdir -p "node_modules/$package"
    printf 'module.exports={};' >"node_modules/$package/index.js"
  done
fi
`, {mode:0o755});
  const run = extra => spawnSync('/bin/sh',[dir+'/seed/seed.sh'],{encoding:'utf8',env:{...process.env,PATH:dir+'/bin:'+process.env.PATH,OCM_DATA_DIR:dir+'/data',OCM_SEED_DIR:dir+'/seed',OCM_BASE_IMAGE:'ecofacis/xfsc-orce:2.0.15',...extra}});
  return {dir,run};
}

test('empty runtime image defaults to the supplied ORCE base and passes runtime preflight', t => {
  for (const image of [undefined,'','ecofacis/xfsc-orce:2.0.15']) {
    const config=jq('normalize_config',{procedureVersion:12,domain:'example.com',runtimeImage:image});
    assert.equal(config.runtimeImage,'ecofacis/xfsc-orce:2.0.15');
    const dir=workspace(t,{'config.json':config,'credentials.json':{editorPassword:'editor-passphrase',uiAdminPassword:'ui-admin-passphrase'}});
    const result=bash(dir,'get_optional() { printf null >"$1"; }; runtime_preflight');
    assert.equal(result.status,0,result.stderr);
  }
});

test('seed installs dependencies and compiles once, then reuses the prepared release', t => {
  const {dir,run}=setup(t);
  let r=run();assert.equal(r.status,0,r.stderr);
  const current=fs.readlinkSync(dir+'/data/current');
  assert.ok(fs.existsSync(current+'/.ready'));
  assert.ok(fs.existsSync(dir+'/data/uibuilder/orce/dist/.vite/manifest.json'));
  const calls=fs.readFileSync(dir+'/data/npm-calls','utf8');
  assert.match(calls,/runtime:install --omit=dev --ignore-scripts/);
  assert.match(calls,/ui:install --include=dev --ignore-scripts/);
  assert.match(calls,/ui:run build/);
  fs.writeFileSync(dir+'/data/retained-user-data','keep');
  r=run();assert.equal(r.status,0,r.stderr);
  assert.equal(fs.readFileSync(dir+'/data/npm-calls','utf8'),calls);
  assert.equal(fs.readlinkSync(dir+'/data/current'),current);
  assert.equal(fs.readFileSync(dir+'/data/retained-user-data','utf8'),'keep');
});

test('failed compilation preserves the active release and retry prepares the changed seed', t => {
  const {dir,run}=setup(t);assert.equal(run().status,0);
  const original=fs.readlinkSync(dir+'/data/current');
  fs.appendFileSync(dir+'/seed/seed.sh','\n# Changed seed revision\n');
  let r=run({FAIL_BUILD:'yes'});assert.equal(r.status,19);
  assert.equal(fs.readlinkSync(dir+'/data/current'),original);
  assert.ok(!fs.readdirSync(dir+'/data/releases').some(x=>x.startsWith('.prepare.')));
  r=run();assert.equal(r.status,0,r.stderr);
  assert.notEqual(fs.readlinkSync(dir+'/data/current'),original);
  assert.ok(fs.existsSync(original+'/.ready'));
});

test('seed refuses unmanaged flows before installing packages or changing the volume', t => {
  const {dir,run}=setup(t);fs.writeFileSync(dir+'/data/flows.json','[]');
  const r=run();assert.notEqual(r.status,0);
  assert.equal(fs.readFileSync(dir+'/data/flows.json','utf8'),'[]');
  assert.ok(!fs.existsSync(dir+'/data/npm-calls'));
  assert.ok(!fs.existsSync(dir+'/data/current'));
});

test('seed archive corruption cannot publish a release', t => {
  const {dir,run}=setup(t);fs.writeFileSync(dir+'/seed/ui.tgz','invalid archive');
  assert.notEqual(run().status,0);
  assert.ok(!fs.existsSync(dir+'/data/current'));
  assert.ok(!fs.existsSync(dir+'/data/npm-calls'));
});
