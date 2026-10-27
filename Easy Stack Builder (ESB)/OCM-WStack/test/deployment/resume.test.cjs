'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {workspace,bash}=require('./helpers.cjs');

// Run the real Bash state machine and process runner against a disk-backed
// simulated Helm server. State survives separate deployment processes.
function fixture(t, mode='normal') {
 const dir=workspace(t,{'server.json':{version:0,info:{status:'absent'}},'chart/Chart.yaml':'name: fixture\nversion: 1.0.0\n','values.json':{a:1},'record.json':null});
 fs.mkdirSync(dir+'/bin');
 fs.writeFileSync(dir+'/bin/helm',`#!/usr/bin/env node
const fs=require('fs'),p=process.env.WORKDIR,args=process.argv.slice(2);
const read=n=>JSON.parse(fs.readFileSync(p+'/'+n)),write=(n,v)=>fs.writeFileSync(p+'/'+n,JSON.stringify(v));
const state=read('server.json');
fs.appendFileSync(p+'/calls',args.join(' ')+'\\n');
if(args[0]==='status') {
 if(fs.existsSync(p+'/read-failures')) {
   let n=Number(fs.readFileSync(p+'/read-failures'));if(n>0){fs.writeFileSync(p+'/read-failures',String(n-1));console.error('connection reset by peer');process.exit(1);}
 }
 if(state.info.status==='absent'){console.error('Error: release: not found');process.exit(1);}
 console.log(JSON.stringify(state));
} else if(args[0]==='upgrade') {
 if(process.env.MODE==='last-response-loss') {
   const file=p+'/write-attempts',count=(fs.existsSync(file)?Number(fs.readFileSync(file)):0)+1;
   fs.writeFileSync(file,String(count));
   if(count<5){console.error('connection reset by peer');process.exit(1);}
 }
 const description=args[args.indexOf('--description')+1];
 write('server.json',{version:state.version+1,info:{status:'deployed',description}});
 if(process.env.MODE==='read-loss')fs.writeFileSync(p+'/read-failures','2');
 if(process.env.MODE==='restart')fs.writeFileSync(p+'/read-failures','30');
 if(['response-loss','last-response-loss'].includes(process.env.MODE)){console.error('connection reset by peer');process.exit(1);}
} else process.exit(99);
`,{mode:0o700});
 const setup=`
export PATH="$WORKDIR/bin:$PATH" ESB_HELM_JOURNAL=true ESB_LOG_DIR="$WORKDIR/logs"
mkdir -p "$ESB_LOG_DIR"
sleep() { SECONDS=$((SECONDS+$1)); }
wait_api_ready() { :; }
verify_lease() { :; }
helm_record_read() { cat "$WORKDIR/record.json"; }
helm_record_write() {
 jq -n --arg namespace "$1" --arg release "$2" --arg digest "$3" --arg state "$4" --argjson revision "$5" --arg operation "$6" \\
  '{namespace:$namespace,release:$release,digest:$digest,state:$state,revision:$revision,operation:$operation}' >"$WORKDIR/record.json"
}
helm_upgrade target demo upgrade --install demo "$WORKDIR/chart" -n target -f "$WORKDIR/values.json"
`;
 return {dir,run:(extraMode=mode)=>bash(dir,setup,{MODE:extraMode}),writes:()=>fs.readFileSync(dir+'/calls','utf8').split('\n').filter(x=>x.startsWith('upgrade')).length};
}

for(const mode of ['normal','read-loss','response-loss']) test(`Helm ${mode} produces one confirmed write`,t=>{
 const f=fixture(t,mode),r=f.run();assert.equal(r.status,0,r.stderr);assert.equal(f.writes(),1);
 const record=JSON.parse(fs.readFileSync(f.dir+'/record.json'));
 assert.equal(record.state,'deployed');assert.equal(record.revision,1);assert.match(record.digest,/^[a-f0-9]{64}$/);
});

test('the last Helm attempt is reconciled after a lost successful response',t=>{
 const f=fixture(t,'last-response-loss'),r=f.run();
 assert.equal(r.status,0,r.stderr);assert.equal(f.writes(),5);
 assert.equal(JSON.parse(fs.readFileSync(f.dir+'/server.json')).version,1);
 assert.equal(JSON.parse(fs.readFileSync(f.dir+'/record.json')).state,'deployed');
});

test('a completed upgrade survives process restart with no duplicate write',t=>{
 const f=fixture(t,'restart'),first=f.run();assert.notEqual(first.status,0);
 assert.equal(f.writes(),1);assert.equal(JSON.parse(fs.readFileSync(f.dir+'/record.json')).state,'applying');
 fs.writeFileSync(f.dir+'/read-failures','0');
 const second=f.run('normal');assert.equal(second.status,0,second.stderr);assert.equal(f.writes(),1);
 const events=fs.readFileSync(f.dir+'/events.jsonl','utf8');assert.match(events,/helm-resumed/);
});

test('changed input after interrupted acknowledgement requires a new Helm revision',t=>{
 const f=fixture(t,'restart');assert.notEqual(f.run().status,0);fs.writeFileSync(f.dir+'/read-failures','0');
 fs.writeFileSync(f.dir+'/values.json','{"a":2}');const next=f.run('normal');
 assert.equal(next.status,0,next.stderr);assert.equal(f.writes(),2);
});

test('normal rerun converges again instead of trusting an old completion marker',t=>{
 const f=fixture(t);assert.equal(f.run().status,0);assert.equal(f.run().status,0);assert.equal(f.writes(),2);
});

test('Helm fingerprint is independent of temporary paths and changes with chart bytes',t=>{
 const dir=workspace(t,{'a/Chart.yaml':'name: a\n','b/Chart.yaml':'name: a\n','a/v.json':'{"key":"private-value"}','b/v.json':'{"key":"private-value"}'});
 const code='helm_intent upgrade --install test "$WORKDIR/a" -f "$WORKDIR/a/v.json"; helm_intent upgrade --install test "$WORKDIR/b" -f "$WORKDIR/b/v.json"';
 const first=bash(dir,code);assert.equal(first.status,0,first.stderr);
 let hashes=first.stdout.trim().split('\n');assert.equal(hashes[0],hashes[1]);assert.ok(!first.stdout.includes('private-value'));
 fs.writeFileSync(dir+'/b/Chart.yaml','name: b\n');hashes=bash(dir,code).stdout.trim().split('\n');assert.notEqual(hashes[0],hashes[1]);
});

test('Helm lock timestamps do not change the intent but dependency digests do',t=>{
 const dir=workspace(t,{'a/Chart.lock':'dependencies: []\ndigest: sha256:abc\ngenerated: "2026-10-27T10:00:00Z"\n',
  'b/Chart.lock':'dependencies: []\ndigest: sha256:abc\ngenerated: "2026-10-27T11:00:00Z"\n'});
 const code='helm_intent "$WORKDIR/a"; helm_intent "$WORKDIR/b"';
 let r=bash(dir,code);assert.equal(r.status,0,r.stderr);
 let hashes=r.stdout.trim().split('\n');assert.equal(hashes[0],hashes[1]);
 fs.writeFileSync(dir+'/b/Chart.lock','dependencies: []\ndigest: sha256:changed\ngenerated: "2026-10-27T11:00:00Z"\n');
 r=bash(dir,code);assert.equal(r.status,0,r.stderr);hashes=r.stdout.trim().split('\n');assert.notEqual(hashes[0],hashes[1]);
});

test('read retries recover from temporary denial without authorizing a write',t=>{
 const dir=workspace(t);const r=bash(dir,`
sleep() { SECONDS=$((SECONDS+$1)); }
count=0
run_capture() {
 count=$((count+1)); LAST_ERROR="$WORKDIR/stderr"; LAST_STATUS=1; LAST_COMMAND_ID=read-test
 if ((count<3)); then printf Forbidden >"$LAST_ERROR"; return 1; fi
 printf '{"items":[]}' >"$1"; LAST_STATUS=0
}
kube_json "$WORKDIR/data.json" -n target get pods -o json
printf '%s' "$count"
`);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'3');
});

test('permanent read denial exhausts the budget and keeps command evidence',t=>{
 const dir=workspace(t);const r=bash(dir,`
sleep() { SECONDS=$((SECONDS+$1)); }
ESB_READ_BUDGET=5
run_capture() { LAST_ERROR="$WORKDIR/stderr"; LAST_STATUS=1; LAST_COMMAND_ID=read-denied; printf Forbidden >"$LAST_ERROR"; return 1; }
kube_json "$WORKDIR/data.json" get pods -o json
`);assert.notEqual(r.status,0);
 const error=JSON.parse(fs.readFileSync(dir+'/error.json'));assert.equal(error.diagnostics.commandId,'read-denied');assert.equal(error.diagnostics.reason,'authorization');
});

test('successful lost marker replace is recognized by readback and is not repeated',t=>{
 const dir=workspace(t,{'marker-server.json':{metadata:{resourceVersion:'1'},data:{}}});
 const r=bash(dir,`
sleep() { :; }
marker_matches() { return 0; }; verify_lease() { return 0; }
kube_json() { cp "$WORKDIR/marker-server.json" "$1"; }
run_capture() {
 cp "$WORKDIR"/marker-update.*/next.json "$WORKDIR/marker-server.json"
 printf write >>"$WORKDIR/writes"; LAST_STATUS=1; LAST_ERROR="$WORKDIR/stderr"; printf EOF >"$LAST_ERROR"; return 1
}
update_marker '{"checkpoint":"runtime"}'
`);assert.equal(r.status,0,r.stderr);assert.equal(fs.readFileSync(dir+'/writes','utf8'),'write');
});

test('retained Secret creation reconciles a lost response without replacing its keys',t=>{
 const dir=workspace(t,{'new.json':{apiVersion:'v1',kind:'Secret',metadata:{name:'runtime',namespace:'ocm-wstack'},type:'Opaque',stringData:{key:'generated-private-key'}},'existing.json':null});
 const r=bash(dir,`
sleep() { :; }; verify_lease() { :; }
get_optional() { cp "$WORKDIR/existing.json" "$1"; }
run_capture() {
 jq 'del(.stringData)+{data:(.stringData|with_entries(.value|=@base64))}' "$WORKDIR/new.json" >"$WORKDIR/existing.json"
 printf create >>"$WORKDIR/writes"; LAST_STATUS=1; LAST_ERROR="$WORKDIR/stderr"; printf EOF >"$LAST_ERROR"; return 1
}
create_retained "$WORKDIR/new.json"
`);assert.equal(r.status,0,r.stderr);assert.equal(fs.readFileSync(dir+'/writes','utf8'),'create');
});

test('retained Secret creation refuses conflicting existing credentials',t=>{
 const desired={kind:'Secret',metadata:{name:'runtime',namespace:'ocm-wstack'},stringData:{key:'new-key'}};
 const dir=workspace(t,{'new.json':desired,'existing.json':{kind:'Secret',metadata:desired.metadata,data:{key:Buffer.from('old-key').toString('base64')}}});
 const r=bash(dir,`
get_optional() { cp "$WORKDIR/existing.json" "$1"; }
run_capture() { touch "$WORKDIR/wrote"; return 1; }
create_retained "$WORKDIR/new.json"
`);assert.notEqual(r.status,0);assert.equal(fs.existsSync(dir+'/wrote'),false);
 assert.equal(JSON.parse(fs.readFileSync(dir+'/error.json')).code,'RESOURCE_EXISTS');
});

function pendingFixture(t,{foreign=false,young=false,conflict=false}={}) {
 const zlib=require('node:zlib'),operation='a'.repeat(32);
 const release={name:'demo',namespace:'target',version:2,info:{status:'pending-upgrade',description:'Preparing upgrade'},manifest:'kind: Deployment'};
 const secret={metadata:{name:'sh.helm.release.v1.demo.v2',namespace:'target',resourceVersion:'7',
  creationTimestamp:new Date(Date.now()-(young?0:3600000)).toISOString().replace(/\.\d+Z$/,'Z'),
  labels:{owner:'helm',name:'demo',version:'2',status:'pending-upgrade','esb.xfsc.io/operation':foreign?'other':operation}},
  data:{release:Buffer.from(zlib.gzipSync(Buffer.from(JSON.stringify(release))).toString('base64')).toString('base64')}};
 const dir=workspace(t,{'helm-state.json':release,'pending-fixture.json':secret,'record.json':{state:'applying',revision:1,operation,timeoutSeconds:60}});
 const r=bash(dir,`
kube_json() { cp "$WORKDIR/pending-fixture.json" "$1"; }
verify_lease() { :; }
run_capture() {
 cp "$WORKDIR/pending-patch.json" "$WORKDIR/applied.json"
 ${conflict?'LAST_STATUS=1; LAST_ERROR="$WORKDIR/stderr"; printf "test failed: resourceVersion" >"$LAST_ERROR"; return 1;':'return 0;'}
}
helm_recover_recorded target demo "$WORKDIR/record.json" 2
`);
 return {dir,r,secret};
}

test('stale ESB Helm operation is backed up and conditionally reopened without deleting resources',t=>{
 const f=pendingFixture(t);assert.equal(f.r.status,0,f.r.stderr);
 const patch=JSON.parse(fs.readFileSync(f.dir+'/applied.json'));
 assert.deepEqual(patch.slice(0,2),[{op:'test',path:'/metadata/resourceVersion',value:'7'},{op:'test',path:'/data/release',value:f.secret.data.release}]);
 assert.equal(patch.at(-1).value,'failed');
 assert.equal(fs.readdirSync(f.dir+'/recovery-backups').length,1);
});
test('pending release from another operation is never modified',t=>{
 const f=pendingFixture(t,{foreign:true});assert.notEqual(f.r.status,0);assert.equal(fs.existsSync(f.dir+'/applied.json'),false);
 assert.equal(JSON.parse(fs.readFileSync(f.dir+'/error.json')).code,'HELM_RECOVERY');
});
test('pending operation within its original timeout remains untouched',t=>{
 const f=pendingFixture(t,{young:true});assert.equal(f.r.status,2);assert.equal(fs.existsSync(f.dir+'/applied.json'),false);
});
test('concurrent Helm record modification stops recovery',t=>{
 const f=pendingFixture(t,{conflict:true});assert.notEqual(f.r.status,0);
 assert.equal(JSON.parse(fs.readFileSync(f.dir+'/error.json')).code,'HELM_RECOVERY');
});

test('a lost lease-create response is reconciled with the same holder',t=>{
 const dir=workspace(t,{'lease-server.json':null});
 const r=bash(dir,`
get_optional() { cp "$WORKDIR/lease-server.json" "$1"; }
sleep() { if [[ $1 == 2 ]]; then return; fi; command sleep "$@"; }
kube_json() {
 cp "$WORKDIR/lease-new.json" "$WORKDIR/lease-server.json"
 printf create >>"$WORKDIR/writes"
 LAST_STATUS=1; LAST_ERROR="$WORKDIR/stderr"; printf EOF >"$LAST_ERROR"
 return 1
}
acquire_lease
trap 'kill -TERM "$LEASE_PID" 2>/dev/null || true; wait "$LEASE_PID" || true' EXIT
lease_valid "$WORKDIR/lease-server.json"
`);
 assert.equal(r.status,0,r.stderr);assert.equal(fs.readFileSync(dir+'/writes','utf8'),'create');
});

test('a live foreign deployment lease blocks all acquisition writes',t=>{
 const dir=workspace(t,{'lease-server.json':{spec:{holderIdentity:'another-operation',renewTime:new Date().toISOString(),leaseDurationSeconds:180}}});
 const r=bash(dir,`
get_optional() { cp "$WORKDIR/lease-server.json" "$1"; }
kube_json() { touch "$WORKDIR/wrote"; }
acquire_lease
`);
 assert.notEqual(r.status,0);assert.equal(fs.existsSync(dir+'/wrote'),false);
 assert.equal(JSON.parse(fs.readFileSync(dir+'/error.json')).code,'BUSY');
});

test('an exhausted read budget never reuses a previous success status',t=>{
 const dir=workspace(t),r=bash(dir,`
LAST_STATUS=0
run_capture() { touch "$WORKDIR/called"; }
read_capture "$WORKDIR/output" 30 0 kubectl get pods
`);
 assert.equal(r.status,124);assert.equal(fs.existsSync(dir+'/called'),false);
});

test('single-workload readiness waits for creation and the current ready generation',t=>{
 const object={kind:'Deployment',metadata:{name:'ocm-orce',generation:2},spec:{replicas:1},
  status:{observedGeneration:2,replicas:1,updatedReplicas:1,readyReplicas:1,availableReplicas:1}};
 const dir=workspace(t,{'deployment.json':object});
 const r=bash(dir,`
sleep() { SECONDS=$((SECONDS+$1)); }
count=0
run_capture() {
 count=$((count+1)); printf '%s\\n' "$*" >>"$WORKDIR/commands"
 if ((count==1)); then : >"$1"; else cp "$WORKDIR/deployment.json" "$1"; fi
}
wait_workloads ocm-wstack deployment/ocm-orce '' '[]' 15
printf '%s' "$count"
`);
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'2');
 assert.match(fs.readFileSync(dir+'/commands','utf8'),/--ignore-not-found/);
});
