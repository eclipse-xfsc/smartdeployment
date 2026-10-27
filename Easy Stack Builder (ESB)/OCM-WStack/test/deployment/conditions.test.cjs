'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { workspace, bash, ROOT } = require('./helpers.cjs');
const object = conditions => ({ metadata: { name: 'policies.kyverno.io' }, status: { conditions } });
const established = object([{ type: 'Established', status: 'True' }]);
function check(t, responses, {resource='crd/policies.kyverno.io', condition='Established', budget=12}={}) {
  const dir = workspace(t, { 'responses.json': responses });
  const r = bash(dir, `
index=0
SECONDS=0
sleep() { SECONDS=$((SECONDS+$1)); }
run_capture() {
 local output=$1 limit=$2
 shift 2
 printf '%s\\n' "$*" >>"$WORKDIR/calls"
 [[ $1 == kubectl && $2 == get && $* != *' wait '* ]] || return 99
 LAST_ERROR="$WORKDIR/stderr"; LAST_STATUS=0; LAST_TIMEOUT=false
 jq --argjson i "$index" '.[([$i,length-1]|min)]' "$WORKDIR/responses.json" >"$WORKDIR/response"
 index=$((index+1))
 if jq -e 'has("error")' "$WORKDIR/response" >/dev/null; then
  jq -r .error "$WORKDIR/response" >"$LAST_ERROR"
  LAST_STATUS=1; return 1
 fi
 jq '.body' "$WORKDIR/response" >"$output"
}
wait_resource_condition '${resource}' '${condition}' '${budget}'
`);
  const err = path.join(dir, 'error.json');
  return {...r, error: fs.existsSync(err) ? JSON.parse(fs.readFileSync(err)) : null,
    calls:fs.readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n'),
    events:fs.readFileSync(path.join(dir,'events.jsonl'),'utf8')};
}
for (const [name,body] of Object.entries({missing:null,noStatus:{metadata:{}},nullStatus:{status:null},nullConditions:object(null),emptyConditions:object([]),falseCondition:object([{type:'Established',status:'False'}])})) {
 test(`resource wait polls ${name} until Established=True`,t=>{
  const r=check(t,[{body},{body:established}]);
  assert.equal(r.status,0,r.stderr);assert.equal(r.calls.length,2);
  assert.match(r.events,/"status":"ready"/);
 });
}
test('temporary API failure is retried within the same condition wait',t=>{
 const r=check(t,[{error:'unexpected EOF'},{body:object(null)},{body:established}]);
 assert.equal(r.status,0,r.stderr);assert.equal(r.calls.length,3);
 assert.match(r.events,/"reason":"connection"/);
});
test('persistent missing conditions end at the configured deadline with resource diagnostics',t=>{
 const r=check(t,[{body:object(null)}],{budget:7});
 assert.notEqual(r.status,0);assert.equal(r.error.code,'RESOURCE_CONDITION_TIMEOUT');
 assert.equal(r.calls.length,3);assert.equal(r.error.diagnostics.resource,'crd/policies.kyverno.io');
 assert.equal(r.error.diagnostics.timeoutSeconds,7);
 assert.match(r.calls.at(-1),/--request-timeout=1s/);
});
for (const [name,body] of Object.entries({terminating:{metadata:{deletionTimestamp:'2026-10-27T10:00:00Z'}},conflict:object([{type:'NamesAccepted',status:'False'}])})) {
 test(`resource wait stops on ${name}`,t=>{
  const r=check(t,[{body},{body:established}]);
  assert.notEqual(r.status,0);assert.equal(r.error.code,'RESOURCE_CONDITION_BLOCKED');assert.equal(r.calls.length,1);
 });
}
test('TLS errors and malformed condition responses are reported without being accepted',t=>{
 const tls=check(t,[{error:'x509: certificate signed by unknown authority'}]);
 assert.equal(tls.error.code,'RESOURCE_CONDITION_READ');assert.equal(tls.calls.length,1);
 const malformed=check(t,[{body:object('invalid')}]);
 assert.equal(malformed.error.code,'RESOURCE_CONDITION_RESPONSE');assert.equal(malformed.calls.length,1);
});
test('policy wait requires Ready=True and current observed generation when supplied',t=>{
 const stale={metadata:{generation:2},status:{conditions:[{type:'Ready',status:'True',observedGeneration:1}]}};
 const current={metadata:{generation:2},status:{conditions:[{type:'Ready',status:'True',observedGeneration:2}]}};
 const r=check(t,[{body:stale},{body:current}],{resource:'clusterpolicy/esb-ocm-tenant-routing',condition:'Ready'});
 assert.equal(r.status,0,r.stderr);assert.equal(r.calls.length,2);
});
test('all deployer CRD and policy condition waits use JSON polling',()=>{
 for(const name of ['kyverno','network','services']) {
  const s=fs.readFileSync(path.join(ROOT,'deployment',name+'.sh'),'utf8');
  assert.ok(!s.includes('kubectl wait'));assert.ok(s.includes('wait_resource_condition'));
 }
});
