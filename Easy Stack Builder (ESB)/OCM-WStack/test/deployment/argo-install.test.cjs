'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { workspace, bash, ROOT } = require('./helpers.cjs');
function scenario(t, responses, options={}) {
 const manifest='apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: argocd-cm\n  namespace: argocd\n';
 const dir=workspace(t,{'argo-install.yaml':manifest,'responses.json':responses,'chart-report.json':{argoManifestSha256:options.changed?'changed':crypto.createHash('sha256').update(manifest).digest('hex')}});
 const r=bash(dir,`
export ESB_ARGO_MANIFEST="$WORKDIR/argo-install.yaml"
TIMEOUT_SECONDS=${options.budget||60}
SECONDS=0
index=0
wait_api_ready() { printf 'readiness %s\\n' "$3" >>"$WORKDIR/trace"; }
verify_lease() { printf 'lease\\n' >>"$WORKDIR/trace"; ${options.lostLease?'fail LEASE_LOST lost; return 1;':':;'} }
sleep() { SECONDS=$((SECONDS+$1)); }
run_capture() {
 local out=$1 limit=$2
 shift 2
 LAST_ERROR="$WORKDIR/stderr";LAST_STATUS=0;LAST_TIMEOUT=false
 printf '%s\\n' "$*" >>"$WORKDIR/trace"
 [[ $1 == kubectl && $2 == apply && $* == *'--server-side --force-conflicts'* ]] || return 99
 if [[ $* == *argo-namespace.json* ]]; then printf namespace-ready >"$out"; return 0; fi
 jq --argjson i "$index" '.[([$i,length-1]|min)]' "$WORKDIR/responses.json" >"$WORKDIR/response"
 index=$((index+1))
 SECONDS=$((SECONDS+$(jq '.elapsed // 0' "$WORKDIR/response")))
 if jq -e 'has("error")' "$WORKDIR/response" >/dev/null; then
  jq -r '.error' "$WORKDIR/response" >"$LAST_ERROR"; LAST_STATUS=1; return 1
 fi
 printf manifest-applied >"$out"
}
argo_install
`);
 return {...r,trace:fs.existsSync(dir+'/trace')?fs.readFileSync(dir+'/trace','utf8'):'',
  error:fs.existsSync(dir+'/error.json')?JSON.parse(fs.readFileSync(dir+'/error.json')):null,
  events:fs.readFileSync(dir+'/events.jsonl','utf8')};
}
const missingRole='Error from server (Forbidden): services "argocd-dex-server" is forbidden: RBAC: [clusterrole.rbac.authorization.k8s.io "cluster-admin" not found]';
test('Argo manifest resumes partial apply after EOF and unavailable default RBAC',t=>{
 const r=scenario(t,[{error:'unexpected EOF'},{error:missingRole},{}]);
 assert.equal(r.status,0,r.stderr);assert.match(r.events,/default-rbac-unavailable/);
 const writes=r.trace.split('\n').filter(x=>x.includes('kubectl apply'));
 assert.equal(writes.length,4);assert.equal(new Set(writes.slice(1)).size,1);
 assert.equal(r.trace.split('\n').filter(x=>x==='lease').length,4);
 assert.ok(!r.trace.includes('create clusterrole'));assert.match(r.stdout,/manifest-applied/);
});
test('persistent transport failures stop after five manifest attempts',t=>{
 const r=scenario(t,[{error:'connection refused'}],{budget:1800});
 assert.equal(r.error.code,'ARGO_INSTALL');assert.equal(r.error.diagnostics.history.length,5);
 assert.equal(r.trace.split('\n').filter(x=>x.includes('argo-install.yaml')).length,5);
});
test('ordinary permission denial does not retry the manifest',t=>{
 const r=scenario(t,[{error:'Error from server (Forbidden): services is forbidden: User cannot patch services'},{}]);
 assert.equal(r.error.code,'ARGO_INSTALL');assert.equal(r.error.diagnostics.history[0].reason,'authorization');
 assert.equal(r.trace.split('\n').filter(x=>x.includes('argo-install.yaml')).length,1);
});
test('certificate and validation failures stop the Argo installation',t=>{
 for(const error of ['x509: certificate signed by unknown authority','validation failed: invalid: field']) {
  const r=scenario(t,[{error},{}]);assert.equal(r.error.code,'ARGO_INSTALL');
  assert.equal(r.trace.split('\n').filter(x=>x.includes('argo-install.yaml')).length,1);
 }
});
test('Argo apply honors the total time budget',t=>{
 const r=scenario(t,[{error:'unexpected EOF',elapsed:10}],{budget:10});
 assert.equal(r.error.code,'ARGO_INSTALL');assert.equal(r.trace.split('\n').filter(x=>x.includes('argo-install.yaml')).length,1);
});
test('Argo manifest changes and lost leases prevent mutation',t=>{
 const changed=scenario(t,[{}],{changed:true});assert.equal(changed.error.code,'ARGO_MANIFEST');assert.equal(changed.trace,'');
 const lost=scenario(t,[{}],{lostLease:true});assert.equal(lost.error.code,'LEASE_LOST');assert.ok(!lost.trace.includes('kubectl apply'));
});
test('pinned bootstrap routes namespace and manifest application through the retry hook',t=>{
 const dir=workspace(t);fs.cpSync(path.join(ROOT,'test/fixtures/upstream'),path.join(dir,'source'),{recursive:true});
 const cp=require('node:child_process');
 const r=cp.spawnSync('git',['apply',path.join(ROOT,'deployment/upstream.patch')],{cwd:path.join(dir,'source'),encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 const script=fs.readFileSync(path.join(dir,'source/argocd-bootstrap.sh'),'utf8');
 assert.match(script,/--internal argo-install/);assert.ok(!script.includes('kubectl apply'));assert.ok(!script.includes('kubectl cluster-info'));
});
