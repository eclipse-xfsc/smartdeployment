'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const {workspace, bash} = require('./helpers.cjs');
function scenario(t, options={}) {
 const manifest = [
 ...['clusterpolicies.kyverno.io','policies.kyverno.io'].map(name => `apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: ${name}\nspec:\n  group: kyverno.io\n`),
 'apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: kyverno:background-controller\nrules: []\n',
 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: unrelated\ndata: {}\n'].join('---\n');
 const release={name:'kyverno',namespace:'security',version:2,info:{status:'pending-upgrade'},manifest,chart:{metadata:{name:'kyverno-wrapper',appVersion:options.wrongVersion?'other':'1.15.2',dependencies:[{name:'kyverno',version:'3.5.2'}]}}};
 const encoded=Buffer.from(zlib.gzipSync(Buffer.from(JSON.stringify(release))).toString('base64')).toString('base64');
 const secret={metadata:{name:'sh.helm.release.v1.kyverno.v2',resourceVersion:'42',creationTimestamp:'2000-01-01T00:00:00Z',labels:{owner:'helm',name:'kyverno',version:'2',status:'pending-upgrade'}},data:{release:encoded}};
 const state={secret,objects:options.existing?{'ClusterRole/kyverno:background-controller':{local:'preserved'}}:{},calls:[],...options};
 const dir=workspace(t,{'state.json':state,clock:options.fresh?'946684805':'946685000','manifest.yaml':manifest,'source/INFRA/security/kyverno/Chart.yaml':'name: kyverno-wrapper'});
 fs.writeFileSync(dir+'/fake.py',String.raw`import sys,json,os,yaml,base64,gzip
from pathlib import Path
p=Path(os.environ['WORKDIR'])/'state.json';s=json.loads(p.read_text());args=sys.argv[1:];s['calls'].append(args)
def finish(data=None,code=0,error=''):
 p.write_text(json.dumps(s))
 if data is not None:print(json.dumps(data) if not isinstance(data,str) else data)
 if error:print(error,file=sys.stderr)
 sys.exit(code)
if args[0]=='helm':
 if args[1]=='template':finish(Path(os.environ['WORKDIR'],'manifest.yaml').read_text())
 finish({'info':{'status':'pending-upgrade'}})
assert args[0]=='kubectl'
a=args[1:]
if 'get' in a:
 i=a.index('get');kind=a[i+1]
 if kind.startswith('crd/'):
  obj=s['objects'].get('CustomResourceDefinition/'+kind.split('/',1)[1])
  if obj:
   s['conditionReads']=s.get('conditionReads',0)+1
   if s.get('delayedConditions') and s['conditionReads']==1:obj={**obj,'status':{'conditions':None}}
   else:obj={**obj,'status':{'conditions':[{'type':'Established','status':'True'}]}}
  finish(obj)
 if kind=='deployments':
  finish({'items':[{'kind':'Deployment','metadata':{'name':'kyverno-'+component+'-controller','generation':1},'spec':{'replicas':1},'status':{'observedGeneration':1,'replicas':1,'updatedReplicas':1,'readyReplicas':0 if s.get('notReady') else 1,'availableReplicas':0 if s.get('notReady') else 1}} for component in ['admission','background','cleanup','reports']]})
 if kind=='secrets':
  items=[s['secret']]
  if s.get('successful'):items+=[{'metadata':{'labels':{'version':'1','status':'deployed'}}}]
  if s.get('changeRecord') and any('deployments' in c for c in s['calls']):items[0]['metadata']['resourceVersion']='43'
  finish({'items':items})
 finish(s['objects'].get(kind+'/'+a[i+2]))
if a[0]=='create':
 obj=yaml.safe_load(Path(a[a.index('-f')+1]).read_text())
 if '--dry-run=client' in a:finish(obj)
 key=obj['kind']+'/'+obj['metadata']['name'];s['objects'][key]=obj
 if s.get('ambiguous'):s['ambiguous']=False;finish(code=1,error='unexpected EOF')
 finish(obj)
if 'rollout' in a:
 if s.get('notReady'):finish(code=1,error='timeout')
 finish('ready')
if 'wait' in a:finish('Established')
if 'patch' in a:
 assert '--patch-file' in a and '-p' not in a
 patch=json.loads(Path(a[a.index('--patch-file')+1]).read_text())
 assert patch[0]['value']==s['secret']['metadata']['resourceVersion']
 assert patch[1]['value']==s['secret']['data']['release']
 s['secret']['data']['release']=patch[2]['value'];s['secret']['metadata']['labels']['status']='failed'
 finish('patched')
finish(code=2,error='unknown fixture call')
`);
 const result=bash(dir,`
export SOURCE="$WORKDIR/source" ESB_RECOVERY_BACKUP_DIR="$WORKDIR/backups"
workload_diagnostics() { :; }
verify_lease() { ${options.lostLease ? 'fail LEASE_LOST lost; return 1;' : ':;'} }
date() { if [[ $* == +%s ]]; then cat "$WORKDIR/clock"; else command date "$@"; fi; }
sleep() { SECONDS=$((SECONDS+$1)); local n; n=$(cat "$WORKDIR/clock"); printf %s "$((n+$1))" >"$WORKDIR/clock"; }
run_capture() {
 local output=$1; shift 2
 LAST_ERROR="$WORKDIR/stderr"; LAST_STATUS=0; LAST_TIMEOUT=false
 python3 "$WORKDIR/fake.py" "$@" >"$output" 2>"$LAST_ERROR" || LAST_STATUS=$?
 return "$LAST_STATUS"
}
${options.backupFailure ? `mktemp() { if [[ $* == *kyverno-before-recovery* ]]; then return 1; else command mktemp "$@"; fi; }` : ''}
${options.copyFailure ? `cp() { if [[ $2 == *kyverno-before-recovery* ]]; then return 1; else command cp "$@"; fi; }` : ''}
${options.portableTemp ? `mktemp() { if [[ $* == *kyverno-before-recovery* && $* != *XXXXXX ]]; then return 1; else command mktemp "$@"; fi; }` : ''}
${options.prepare ? 'kyverno_prepare' : 'release_status security kyverno'}
`);
 return {dir,result,state:JSON.parse(fs.readFileSync(dir+'/state.json')),events:fs.readFileSync(dir+'/events.jsonl','utf8')};
}
test('stale interrupted bootstrap restores missing CRDs/RBAC, backs up and conditionally clears pending state',t=>{
 const {dir,result,state}=scenario(t);assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'failed');
 assert.equal(Object.keys(state.objects).length,3);assert.ok(!state.objects['Secret/unrelated']);
 assert.equal(state.secret.metadata.labels.status,'failed');
 const patchIndex=state.calls.findIndex(c=>c.includes('patch'));assert.equal(state.calls.slice(0,patchIndex).filter(c=>c.includes('deployments')).length,1);
 assert.equal(fs.readdirSync(dir+'/backups').length,1);
 const backup=JSON.parse(fs.readFileSync(dir+'/backups/'+fs.readdirSync(dir+'/backups')[0]));assert.equal(backup.metadata.labels.status,'pending-upgrade');
 for(const obj of Object.values(state.objects)){assert.equal(obj.metadata.annotations['meta.helm.sh/release-name'],'kyverno');}
 assert.ok(!state.calls.some(c=>c.includes('delete')||c.includes('apply')));
});
test('fresh pending operation is observed until its configured timeout and grace expire',t=>{
 const {result,state,events}=scenario(t,{fresh:true});assert.equal(result.status,0,result.stderr);
 assert.match(events,/helm-recovery-wait/);assert.ok(state.calls.some(c=>c[0]=='helm'&&c[1]=='status'));
});
for(const [name,options] of Object.entries({successful:{successful:true},wrongVersion:{wrongVersion:true},lostLease:{lostLease:true},changedRecord:{changeRecord:true},unreadyController:{notReady:true}})){
 test(`Kyverno recovery preserves pending state for ${name}`,t=>{
  const {result,state}=scenario(t,options);assert.notEqual(result.status,0,result.stderr);assert.ok(!result.stderr.includes('syntax error'));assert.equal(state.secret.metadata.labels.status,'pending-upgrade');assert.ok(!state.calls.some(c=>c.includes('patch')));
 });
}
test('existing resources are preserved while ambiguous creates are reconciled by reads',t=>{
 const {result,state}=scenario(t,{existing:true,ambiguous:true});assert.equal(result.status,0,result.stderr);
 assert.deepEqual(state.objects['ClusterRole/kyverno:background-controller'],{local:'preserved'});
 assert.equal(state.calls.filter(c=>c.includes('create')&&!c.includes('--dry-run=client')).length,2);
});
test('prerequisites are created with Helm ownership before an initial install',t=>{
 const {result,state}=scenario(t,{prepare:true});assert.equal(result.status,0,result.stderr);assert.equal(Object.keys(state.objects).length,3);assert.ok(!state.calls.some(c=>c.includes('patch')));
});

test('Kyverno prerequisite creation tolerates a null initial conditions field',t=>{
 const {result,state,events}=scenario(t,{prepare:true,delayedConditions:true});
 assert.equal(result.status,0,result.stderr);assert.match(events,/"status":"waiting"/);
 assert.ok(state.conditionReads>=3);assert.ok(!state.calls.some(c=>c.includes('wait')));
});

for(const name of ['backupFailure','copyFailure']) test(`Kyverno recovery stops before changes when ${name}`,t=>{
 const {dir,result,state}=scenario(t,{[name]:true});
 assert.notEqual(result.status,0);assert.equal(JSON.parse(fs.readFileSync(dir+'/error.json')).code,'KYVERNO_BACKUP');
 assert.ok(!state.calls.some(c=>c.includes('patch')||(c.includes('create')&&!c.includes('--dry-run=client'))));
 assert.equal(state.secret.metadata.labels.status,'pending-upgrade');
});
test('Kyverno backup uses a trailing-X template supported by target mktemp',t=>{
 const {result,state}=scenario(t,{portableTemp:true});assert.equal(result.status,0,result.stderr);assert.equal(state.secret.metadata.labels.status,'failed');
});
