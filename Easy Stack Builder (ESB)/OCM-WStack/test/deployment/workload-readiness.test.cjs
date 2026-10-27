'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {workspace,bash,ROOT}=require('./helpers.cjs');
const cp=require('node:child_process');
const path=require('node:path');
function deployment(change={}) {
 const obj={kind:'Deployment',metadata:{name:'argocd-server',generation:3},spec:{replicas:1},
  status:{observedGeneration:3,replicas:1,updatedReplicas:1,readyReplicas:1,availableReplicas:1}};
 return {...obj,...change};
}
const list=(...items)=>({kind:'List',items});
function report(objects, expected=[]) {
 const p=cp.spawnSync('jq',['-L',path.join(ROOT,'deployment'),'--argjson','expected',JSON.stringify(expected),
  'include "readiness"; workload_report($expected)'],{input:JSON.stringify(objects),encoding:'utf8'});
 assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
}
function run(t,responses,{budget=15,expected='["Deployment/argocd-server"]',selector='app=argocd',diagnostics=false}={}) {
 const dir=workspace(t,{'responses.json':responses});
 const r=bash(dir,`
SECONDS=0; index=0
sleep() { SECONDS=$((SECONDS+$1)); }
${diagnostics?'':'workload_diagnostics() { printf "diagnostics %s\\n" "$1" >>"$WORKDIR/trace"; }'}
run_capture() {
 local output=$1 limit=$2;shift 2
 printf '%s\\n' "$*" >>"$WORKDIR/trace"
 LAST_ERROR="$WORKDIR/err";LAST_STATUS=0
 jq --argjson i "$index" '.[([$i,length-1]|min)]' "$WORKDIR/responses.json" >"$WORKDIR/response"
 index=$((index+1))
 SECONDS=$((SECONDS+$(jq '.elapsed // 0' "$WORKDIR/response")))
 if jq -e '.error' "$WORKDIR/response" >/dev/null; then
  jq -r '.error' "$WORKDIR/response" >"$LAST_ERROR";LAST_STATUS=1;return 1
 fi
 jq '.object' "$WORKDIR/response" >"$output"
}
wait_workloads argocd deployments '${selector}' '${expected}' ${budget}
`);
 return {...r,error:fs.existsSync(dir+'/error.json')?JSON.parse(fs.readFileSync(dir+'/error.json')):null,
  trace:fs.readFileSync(dir+'/trace','utf8'),events:fs.readFileSync(dir+'/events.jsonl','utf8')};
}
test('readiness waits through a previous progress deadline until current replicas are ready',t=>{
 const blocked=deployment();blocked.status.readyReplicas=0;blocked.status.availableReplicas=0;
 blocked.status.conditions=[{type:'Progressing',status:'False',reason:'ProgressDeadlineExceeded'}];
 const r=run(t,[{object:list(blocked)},{error:'connection reset by peer'},{object:list(deployment())}]);
 assert.equal(r.status,0,r.stderr);assert.match(r.events,/ProgressDeadlineExceeded/);assert.match(r.events,/workloads-ready/);
 assert.ok(!r.trace.includes('rollout'));assert.ok(!r.trace.includes('diagnostics'));
});
test('a failed API read cannot reuse an earlier ready-looking result',t=>{
 const r=run(t,[{error:'unexpected EOF'}]);assert.equal(r.error.code,'WORKLOAD_TIMEOUT');
 assert.match(r.trace,/diagnostics argocd/);assert.ok(!r.events.includes('workloads-ready'));
});
test('missing Argo components cannot pass readiness',()=>{
 assert.equal(report(list(deployment()),['Deployment/argocd-server','StatefulSet/argocd-application-controller']).ready,false);
 assert.equal(report(list()).ready,false);
});
test('old generation, old replicas, paused or deleting deployments remain pending',()=>{
 for(const change of [o=>o.status.observedGeneration=2,o=>o.status.updatedReplicas=0,
  o=>o.status.replicas=2,o=>o.status.availableReplicas=0,o=>o.metadata.deletionTimestamp='now',o=>o.spec.paused=true]) {
  const obj=deployment();change(obj);assert.equal(report(list(obj)).ready,false);
 }
});
test('StatefulSet requires matching current and update revisions and ready updated replicas',()=>{
 const obj=deployment({kind:'StatefulSet'});obj.status.currentRevision='old';obj.status.updateRevision='new';
 assert.equal(report(list(obj)).ready,false);obj.status.currentRevision='new';assert.equal(report(list(obj)).ready,true);
 obj.status.updatedReplicas=0;assert.equal(report(list(obj)).ready,false);
});
test('Pod readiness requires Ready condition and all containers',()=>{
 const obj={kind:'Pod',metadata:{name:'openbao-0'},spec:{containers:[{name:'openbao'}]},status:{phase:'Running',conditions:[],containerStatuses:[{name:'openbao',ready:true}]}};
 assert.equal(report(list(obj)).ready,false);obj.status.conditions=[{type:'Ready',status:'True'}];assert.equal(report(list(obj)).ready,true);
 obj.status.containerStatuses=[];assert.equal(report(list(obj)).ready,false);
});
test('timeout reports blocking workloads and never deletes or restarts resources',t=>{
 const obj=deployment();obj.status.readyReplicas=0;
 const r=run(t,[{object:list(obj)}]);assert.equal(r.error.code,'WORKLOAD_TIMEOUT');
 assert.equal(r.error.diagnostics.readiness.workloads[0].resource,'Deployment/argocd-server');
 assert.equal(r.error.diagnostics.timeoutSeconds,15);assert.ok(!/delete|patch|restart/.test(r.trace));
});
test('certificate errors fail with the original workload error and collect diagnostics',t=>{
 const r=run(t,[{error:'x509: certificate signed by unknown authority'}]);
 assert.equal(r.error.code,'WORKLOAD_READ');assert.match(r.trace,/diagnostics/);
});
test('empty and malformed list responses cannot report success',t=>{
 for(const object of [{},list()]) {
  const r=run(t,[{object}]);assert.notEqual(r.status,0);assert.ok(!r.events.includes('workloads-ready'));
 }
});
test('diagnostics capture prior crashes, init failures, events and current logs without changing the result',t=>{
 const pods=list({metadata:{name:'argocd-repo-server-x'},status:{phase:'Pending',conditions:[],
  initContainerStatuses:[{name:'copyutil',ready:false,restartCount:1,lastState:{terminated:{exitCode:1}},state:{waiting:{reason:'CrashLoopBackOff'}}}],
  containerStatuses:[{name:'server',ready:false,restartCount:0,state:{waiting:{reason:'PodInitializing'}}}]}});
 const dir=workspace(t,{'pods.json':pods,'error.json':{code:'WORKLOAD_TIMEOUT'}});
 const r=bash(dir,`
SECONDS=0
run_capture() {
 local out=$1;shift 2;printf '%s\\n' "$*" >>"$WORKDIR/trace"
 case "$2" in
  get) if [[ "$3" == pods ]]; then cp "$WORKDIR/pods.json" "$out";else printf '{"items":[{"reason":"FailedMount","message":"configmap not found"}]}' >"$out";fi ;;
  logs) printf 'configmap "argocd-cm" not found\\n' >"$out" ;;
  *) return 99 ;;
 esac
}
workload_diagnostics argocd app.kubernetes.io/part-of=argocd
`);
 assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/FailedMount/);assert.match(r.stderr,/configmap.*not found/);
 assert.equal(JSON.parse(fs.readFileSync(dir+'/error.json')).code,'WORKLOAD_TIMEOUT');
 const trace=fs.readFileSync(dir+'/trace','utf8');assert.match(trace,/copyutil.*--previous/);assert.match(trace,/logs.*server/);
 assert.ok(!trace.includes('get secret'));
});
test('pinned bootstrap uses a common readiness check and no initial password regeneration',t=>{
 const dir=workspace(t);fs.cpSync(path.join(ROOT,'test/fixtures/upstream'),dir+'/source',{recursive:true});
 const p=cp.spawnSync('git',['apply',path.join(ROOT,'deployment/upstream.patch')],{cwd:dir+'/source',encoding:'utf8'});assert.equal(p.status,0,p.stderr);
 const argo=fs.readFileSync(dir+'/source/argocd-bootstrap.sh','utf8');assert.ok(!argo.includes('kubectl rollout status'));
 assert.equal((argo.match(/--internal argo-health/g)||[]).length,1);assert.ok(!argo.includes('kubectl get secret'));
 const basic=fs.readFileSync(dir+'/source/basic-cluster-init.sh','utf8');assert.ok(!basic.includes('kubectl rollout status'));
 assert.equal((basic.match(/--internal workload-ready/g)||[]).length,5);
});
