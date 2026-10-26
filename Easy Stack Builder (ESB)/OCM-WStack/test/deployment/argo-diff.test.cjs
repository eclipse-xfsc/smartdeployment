'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {ROOT} = require('./helpers.cjs');
const expected = require('./fixtures/verification-injected-env.json');
const patch = fs.readFileSync(path.join(ROOT,'deployment/templates/routing-patch.yaml'),'utf8');
const expression = patch.match(/        - >-\n([\s\S]*?)(?=    - group:)/)[1].split('\n').map(x=>x.trim()).join(' ');
function normalize(value) {
  const r=spawnSync('jq',[`del(${expression})`],{input:JSON.stringify(value),encoding:'utf8'});
  assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout);
}
function deployment(env) {return {spec:{template:{spec:{containers:[{name:'credential-verification-service',env}]}}}};}
const base=[{name:'CREDENTIALVERIFICATION_SERVERMODE',value:'production'},{name:'CREDENTIALVERIFICATION_REGION',value:'EU'}];
test('Verification comparison accepts the observed relocation and reversed order of the complete injected block',()=>{
  const left=deployment([...expected,...base]);
  const right=deployment([...base,...[...expected].reverse()]);
  assert.deepEqual(normalize(left),normalize(right));
});
for (const [name,change] of [
  ['changed endpoint', e=>{e[1].value='foreign.example';}],
  ['missing entry',e=>e.pop()],
  ['duplicate entry',e=>e.push({...e[0]})],
  ['Secret reference',e=>{delete e[0].value;e[0].valueFrom={secretKeyRef:{name:'other',key:'key'}};}],
]) test(`Verification comparison retains ${name}`,()=>{
  const changed=structuredClone(expected);change(changed);
  assert.notDeepEqual(normalize(deployment([...base,...expected])),normalize(deployment([...base,...changed])));
});
test('normalization leaves unrelated fields and other containers visible',()=>{
  const left=deployment([...base,...expected]);const right=structuredClone(left);
  right.spec.template.spec.containers[0].env[0].value='development';
  assert.notDeepEqual(normalize(left),normalize(right));
  right.spec.template.spec.containers[0].name='other';
  assert.deepEqual(normalize(right),right);
});
test('signing Secret normalization equates empty and absent maps while retaining other keys',()=>{
  assert.match(patch,/jsonPointers: \[\/data\/state-signing-key\]\n      jqPathExpressions:\n        - '\.data \| select\(\. == \{\}\)'/);
  const norm=value=>{
    const r=spawnSync('jq',['del(.data["state-signing-key"]) | del(.data | select(. == {}))'],{input:JSON.stringify(value),encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  };
  assert.deepEqual(norm({data:{'state-signing-key':'existing'}}),norm({}));
  assert.notDeepEqual(norm({data:{'state-signing-key':'existing',unexpected:'retained'}}),norm({}));
});
