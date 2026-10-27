'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const crypto=require('node:crypto');const {workspace,bash}=require('./helpers.cjs');
const objects=[
 ...['argocd-cm','argocd-cmd-params-cm','argocd-gpg-keys-cm','argocd-rbac-cm','argocd-ssh-known-hosts-cm','argocd-tls-certs-cm'].map(name=>({apiVersion:'v1',kind:'ConfigMap',metadata:{name}})),
 {apiVersion:'v1',kind:'Secret',metadata:{name:'argocd-secret'}},
 ...['redis','dex-server','server','repo-server','applicationset-controller','notifications-controller','application-controller'].map(name=>({apiVersion:'apps/v1',kind:name==='application-controller'?'StatefulSet':'Deployment',metadata:{name:'argocd-'+name,labels:{'app.kubernetes.io/part-of':'argocd'}},spec:{replicas:1}}))
];
// JSON documents are valid YAML; exercise the production document splitting and
// classification while substituting only the existing Helm YAML parser.
function scenario(t,{missingReads=0,readError='',wrongManifest=false,leaseLost=false,budget=45}={}) {
 const manifest=objects.map(o=>JSON.stringify(o)).join('\n---\n')+'\n';
 const dir=workspace(t,{'argo-install.yaml':manifest,'chart-report.json':{argoManifestSha256:crypto.createHash('sha256').update(manifest).digest('hex')}});
 const r=bash(dir,`
SECONDS=0;TIMEOUT_SECONDS=${budget}; reads=0
export ESB_ARGO_MANIFEST="$WORKDIR/argo-install.yaml"
sleep() { SECONDS=$((SECONDS+$1)); }
read_yaml() { jq 'map_values(fromjson)' "$1" >"$2"; }
argo_apply() { printf 'apply %s\\n' "$(basename "$1")" >>"$WORKDIR/trace"; ${leaseLost?'fail LEASE_LOST lost; return 1;':':;'} }
run_capture() {
 local out=$1;shift 2;reads=$((reads+1))
 printf '%s\\n' "$*" >>"$WORKDIR/trace"
 LAST_ERROR="$WORKDIR/stderr";LAST_STATUS=1
 ${readError?`printf '%s' '${readError}' >"$LAST_ERROR";return 1;`:''}
 if ((reads<=${missingReads})); then
  printf 'ConfigMap/argocd-cm\\n' >"$out"
 else
  cat "$WORKDIR/argo-required.txt" >"$out"
 fi
}
${wrongManifest?'printf corrupted >"$ESB_ARGO_MANIFEST";':''}
argo_install
`);
 return {...r,dir,trace:fs.existsSync(dir+'/trace')?fs.readFileSync(dir+'/trace','utf8'):'',events:fs.readFileSync(dir+'/events.jsonl','utf8'),
  error:fs.existsSync(dir+'/error.json')?JSON.parse(fs.readFileSync(dir+'/error.json')):null};
}
test('Argo prerequisites are read back before any workload is applied',t=>{
 const r=scenario(t,{missingReads:2});assert.equal(r.status,0,r.stderr);
 const calls=r.trace.trim().split('\n');assert.equal(calls[0],'apply argo-namespace.json');assert.equal(calls[1],'apply argo-prerequisites.json');
 assert.equal(calls.at(-1),'apply argo-workloads.json');assert.equal(calls.filter(x=>x.startsWith('kubectl get')).length,3);
 assert.match(r.events,/argocd-tls-certs-cm/);assert.ok(calls.every(c=>!c.includes('-o json ')));
 const prerequisites=JSON.parse(fs.readFileSync(r.dir+'/argo-prerequisites.json'));
 assert.ok(prerequisites.items.every(o=>!['Deployment','StatefulSet'].includes(o.kind)));
 assert.equal(JSON.parse(fs.readFileSync(r.dir+'/argo-workloads.json')).items.length,7);
});
test('persistently missing ConfigMaps stop before starting workloads',t=>{
 const r=scenario(t,{missingReads:100});assert.notEqual(r.status,0);assert.equal(r.error.code,'ARGO_PREREQUISITES');
 assert.ok(r.error.diagnostics.missing.includes('ConfigMap/argocd-tls-certs-cm'));
 assert.ok(!r.trace.includes('apply argo-workloads.json'));assert.equal(r.trace.split('\n').filter(x=>x==='apply argo-prerequisites.json').length,2);
});
test('unavailable API while checking prerequisites is bounded by the same deadline',t=>{
 const r=scenario(t,{readError:'connection reset by peer'});assert.equal(r.error.code,'ARGO_PREREQUISITES');assert.ok(!r.trace.includes('apply argo-workloads.json'));
});
test('certificate verification and manifest integrity remain enforced',t=>{
 const r=scenario(t,{readError:'x509: certificate signed by unknown authority'});assert.equal(r.error.code,'ARGO_PREREQUISITES');assert.equal(r.trace.split('\n').filter(x=>x.startsWith('kubectl get')).length,1);
 const wrong=scenario(t,{wrongManifest:true});assert.equal(wrong.error.code,'ARGO_MANIFEST');assert.equal(wrong.trace,'');
});
test('lost lease stops before prerequisite and workload writes',t=>{
 const r=scenario(t,{leaseLost:true});assert.equal(r.error.code,'LEASE_LOST');assert.equal(r.trace.trim(),'apply argo-namespace.json');
});

test('staging preserves all 59 resources from the pinned Argo install manifest',t=>{
 const {ROOT}=require('./helpers.cjs');const path=require('node:path');const zlib=require('node:zlib');
 const data=zlib.gunzipSync(fs.readFileSync(path.join(ROOT,'test/fixtures/argocd-c9c369ef-install.yaml.gz')));
 assert.equal(crypto.createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex'),'5c4774b2c4bae70a1e0af6a0d08f42e734775905');
 const dir=workspace(t);fs.writeFileSync(dir+'/argo-install.yaml',data);
 fs.writeFileSync(dir+'/parse.py',`import sys,json,yaml\nfrom pathlib import Path\ndocuments=json.loads(Path(sys.argv[1]).read_text())\nPath(sys.argv[2]).write_text(json.dumps({key:yaml.safe_load(text) for key,text in documents.items()}))\n`);
 const r=bash(dir,`
export ESB_ARGO_MANIFEST="$WORKDIR/argo-install.yaml"
read_yaml() { python3 "$WORKDIR/parse.py" "$1" "$2"; }
argo_prepare_manifest
`);
 assert.equal(r.status,0,r.stderr);
 const original=JSON.parse(fs.readFileSync(dir+'/argo-objects.json'));
 const prerequisites=JSON.parse(fs.readFileSync(dir+'/argo-prerequisites.json')).items;
 const workloads=JSON.parse(fs.readFileSync(dir+'/argo-workloads.json')).items;
 assert.equal(original.length,59);assert.equal(prerequisites.length,52);assert.equal(workloads.length,7);
 assert.equal(prerequisites.filter(o=>o.kind==='ConfigMap').length,7);
 const key=o=>o.kind+'/'+o.metadata.name;
 assert.deepEqual([...prerequisites,...workloads].sort((a,b)=>key(a).localeCompare(key(b))),original.sort((a,b)=>key(a).localeCompare(key(b))));
 assert.ok(prerequisites.filter(o=>o.kind==='Secret').every(o=>!o.data&&!o.stringData));
});
