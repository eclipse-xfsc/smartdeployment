'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { jq, workspace, bash } = require('./helpers.cjs');

function fixture() {
  return {
    deployments: [{metadata:{name:'retrieval'},spec:{template:{spec:{containers:[{
      name:'retrieval',env:[{name:'DB_PASSWORD',valueFrom:{secretKeyRef:{name:'retrieval-credentials',key:'password'}}}],
    }]}}}}],
    claims: [{kind:'ResourceClaim',metadata:{name:'retrieval-db',namespace:'ocm-wstack',generation:2},
      spec:{type:'cassandra',providerRef:{name:'cassandra'},externalSecretRef:{name:'retrieval-credentials'},parameters:{keyspace:'ocm'}},
      status:{observedGeneration:2,conditions:[{type:'Ready',status:'True',reason:'Provisioned',observedGeneration:2}]}}],
    external: [{kind:'ExternalSecret',metadata:{name:'retrieval-credentials',namespace:'ocm-wstack',uid:'eso-uid',resourceVersion:'18',annotations:{keep:'value'}},
      spec:{target:{name:'retrieval-credentials'},secretStoreRef:{name:'openbao',kind:'SecretStore'},
        data:[{secretKey:'password',remoteRef:{key:'ocm-wstack/system/cassandra',property:'password'}}]},
      status:{conditions:[{type:'Ready',status:'True',reason:'SecretSynced'}]}}],
    secrets: [{metadata:{name:'retrieval-credentials'},data:{password:Buffer.from('private-password').toString('base64')}}],
  };
}
function report(f) {
  return jq('native_credential_status($claims;$external;$secrets)',f.deployments,f);
}

function pendingFixture() {
  const f=fixture(); f.secrets=[];
  f.claims[0].status.conditions[0]={type:'Ready',status:'False',reason:'ClaimSecretPending',observedGeneration:2};
  f.external[0].status.conditions[0]={type:'Ready',status:'True',reason:'SecretDeleted'};
  f.planned=structuredClone([...f.claims,...f.external]);
  return f;
}

test('ESO SecretDeleted with Ready=True remains pending until the target exists and is synced', () => {
  const f=pendingFixture();
  assert.equal(report(f).ready,false);
  assert.equal(report(f).pending[0].externalSecretReady,false);
  f.secrets=fixture().secrets;
  f.claims=fixture().claims;
  assert.equal(report(f).ready,false);
  f.external[0].status.conditions[0].reason='SecretSynced';
  assert.equal(report(f).ready,true);
});

test('credential refresh is limited to the validated claim and ExternalSecret binding', () => {
  const targets=f=>jq('credential_refresh_targets($pending;$claims;$planned)',f.external,{...f,pending:report(f)});
  assert.equal(targets(pendingFixture()).length,1);
  for(const change of [
    f=>{f.planned=[];},
    f=>{f.claims[0].spec.parameters.keyspace='foreign';},
    f=>{f.claims[0].status.conditions[0].observedGeneration=1;},
    f=>{f.claims[0].status.conditions[0].reason='OpenBaoWriteFailed';},
    f=>{f.external[0].spec.secretStoreRef.name='foreign';},
    f=>{f.external[0].spec.data[0].remoteRef.key='other/secret';},
    f=>{delete f.external[0].metadata.resourceVersion;},
    f=>{f.secrets=fixture().secrets;},
  ]) {
    const f=pendingFixture();change(f);assert.deepEqual(targets(f),[]);
  }
});

test('refresh annotates pending ESO targets with version checks, preserves annotations and limits retries', t => {
  const f=pendingFixture();
  const dir=workspace(t,{'provider-documents.json':f.planned,'startup-external.json':{items:f.external},
    'startup-claims.json':{items:f.claims},'credential-status.json':report(f)});
  const r=bash(dir,`
verify_lease() { printf 'lease\\n' >>"$WORKDIR/order"; }
run_capture() {
  [[ "$*" == *'kubectl -n ocm-wstack patch externalsecret retrieval-credentials --type=json --patch-file '* ]] || return 1
  printf 'patch\\n' >>"$WORKDIR/order"
  cat "$WORKDIR/credential-refresh-patch.json" >>"$WORKDIR/patches"
}
SECONDS=0
refresh_pending_credentials
refresh_pending_credentials
SECONDS=$(jq -r '.["eso-uid"]+60' "$WORKDIR/credential-refresh-times.json")
refresh_pending_credentials
`);
  assert.equal(r.status,0,r.stderr);
  assert.equal(fs.readFileSync(dir+'/order','utf8'),'lease\npatch\nlease\npatch\n');
  const patch=JSON.parse(fs.readFileSync(dir+'/credential-refresh-patch.json'));
  assert.deepEqual(patch.slice(0,2),[
    {op:'test',path:'/metadata/uid',value:'eso-uid'},
    {op:'test',path:'/metadata/resourceVersion',value:'18'},
  ]);
  assert.equal(patch[2].value.keep,'value');
  assert.ok(patch[2].value['force-sync']);
  assert.ok(!fs.readFileSync(dir+'/events.jsonl','utf8').includes('password'));
});

test('refresh retries a changed object on the next read and returns permission errors', t => {
  for(const [error,expected] of [['test operation does not apply',0],['Forbidden private-response',1]]) {
    const f=pendingFixture();
    const dir=workspace(t,{'provider-documents.json':f.planned,'startup-external.json':{items:f.external},
      'startup-claims.json':{items:f.claims},'credential-status.json':report(f),'api-error':error});
    const r=bash(dir,`
verify_lease() { :; }
run_capture() { LAST_ERROR="$WORKDIR/api-error"; return 1; }
refresh_pending_credentials
`);
    assert.equal(r.status,expected,r.stderr);
    if(expected) {
      const failure=JSON.parse(fs.readFileSync(dir+'/error.json'));
      assert.equal(failure.code,'KUBERNETES');assert.ok(!failure.message.includes('private-response'));
    }
  }
});

test('native credentials require current provisioning and a populated consumer Secret', () => {
  const f = fixture();
  assert.deepEqual(report(f),{ready:true,pending:[]});
  f.claims[0].status.conditions[0].observedGeneration = 1;
  assert.equal(report(f).ready,false);
  f.claims[0].status.conditions[0].observedGeneration = 2;
  f.secrets[0].data.password = '';
  assert.equal(report(f).pending[0].present,false);
});

test('missing credentials report controller condition codes without credential or message contents', () => {
  const f = fixture();
  f.secrets = [];
  f.claims[0].status.conditions[0] = {type:'Ready',status:'False',reason:'OpenBaoWriteFailed',message:'private-response'};
  f.external[0].status.conditions[0] = {type:'Ready',status:'False',reason:'SecretSyncedError',message:'private-response'};
  const r = report(f);
  assert.equal(r.ready,false);
  assert.deepEqual(r.pending[0],{
    workload:'retrieval',secret:'retrieval-credentials',key:'password',present:false,
    externalSecret:'retrieval-credentials',externalSecretReady:false,externalSecretReason:'SecretSyncedError',
    claim:'retrieval-db',claimReady:false,claimReason:'OpenBaoWriteFailed',ready:false,
  });
  assert.ok(!JSON.stringify(r).includes('private'));
});

test('manually provided and optional Secrets retain their startup behavior', () => {
  const f = fixture(); f.claims=[]; f.external=[];
  assert.equal(report(f).ready,true);
  f.secrets=[];
  assert.equal(report(f).ready,false);
  f.deployments[0].spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.optional=true;
  assert.deepEqual(report(f),{ready:true,pending:[]});
});

test('a synced ESO target waits for a current Ready claim before native startup', () => {
  const f = fixture();
  f.claims[0].status.conditions[0].status='False';
  f.claims[0].status.conditions[0].reason='ProvisioningFailed';
  assert.equal(report(f).pending[0].claimReason,'ProvisioningFailed');
  f.claims[0].status.conditions[0].reason='sensitive details here';
  assert.equal(report(f).pending[0].claimReason,'Pending');
});

test('native startup reports the missing consumer credential before returning a timeout', t => {
  const f = fixture();
  f.deployments[0].metadata.name='credential-retrieval-service';
  f.deployments[0].spec.strategy={type:'Recreate'};
  f.secrets=[];
  f.claims[0].status.conditions[0]={type:'Ready',status:'False',reason:'ClaimSecretPending'};
  const dir=workspace(t,{
    'deployments.json':{items:f.deployments},'claims.json':{items:f.claims},
    'external.json':{items:f.external},'secrets.json':{items:f.secrets},
    'provider-documents.json':[],
  });
  const r=bash(dir,`
kube_json() {
  local output=$1; shift
  case "$*" in
    '-n ocm-wstack get deployments -o json') cp "$WORKDIR/deployments.json" "$output" ;;
    '-n ocm-wstack get resourceclaims.resources.xfsc.io -o json') cp "$WORKDIR/claims.json" "$output" ;;
    '-n ocm-wstack get externalsecrets.external-secrets.io -o json') cp "$WORKDIR/external.json" "$output" ;;
    '-n ocm-wstack get secrets -o json') cp "$WORKDIR/secrets.json" "$output" ;;
    '-n ocm-wstack get pods -o json') printf '{"items":[]}' >"$output" ;;
    *) return 1 ;;
  esac
}
sleep() { SECONDS=1000; }
native_startup
`);
  assert.notEqual(r.status,0);
  const error=JSON.parse(fs.readFileSync(dir+'/error.json'));
  assert.equal(error.code,'OCM_CREDENTIALS_PENDING');
  assert.match(error.message,/credential-retrieval-service/);
  const events=fs.readFileSync(dir+'/events.jsonl','utf8').trim().split('\n').map(JSON.parse);
  const credentials=events.find(e=>e.type==='ocm-credentials');
  assert.equal(credentials.pending[0].claimReason,'ClaimSecretPending');
  assert.equal(credentials.pending[0].present,false);
});

test('startup refreshes an initially deleted ESO target and waits for provisioning and workload readiness', t => {
  const f=pendingFixture();
  const deployment=f.deployments[0];
  deployment.metadata={name:'credential-retrieval-service',generation:1};
  deployment.spec.strategy={type:'Recreate'};
  deployment.spec.replicas=1;
  deployment.status={observedGeneration:1,replicas:1,updatedReplicas:1,readyReplicas:0,availableReplicas:0};
  const dir=workspace(t,{
    'config.json':{runtimeServices:{didcomm:'http://external-didcomm'}},
    'deployments.json':{items:f.deployments},'claims.json':{items:f.claims},
    'external.json':{items:f.external},'secrets.json':{items:[]},
    'provisioned-secrets.json':{items:fixture().secrets},'provider-documents.json':f.planned,
  });
  const r=bash(dir,`
kube_json() {
  local output=$1; shift
  case "$*" in
    '-n ocm-wstack get deployments -o json') cp "$WORKDIR/deployments.json" "$output" ;;
    '-n ocm-wstack get resourceclaims.resources.xfsc.io -o json') cp "$WORKDIR/claims.json" "$output" ;;
    '-n ocm-wstack get externalsecrets.external-secrets.io -o json') cp "$WORKDIR/external.json" "$output" ;;
    '-n ocm-wstack get secrets -o json') cp "$WORKDIR/secrets.json" "$output" ;;
    '-n ocm-wstack get pods -o json') printf '{"items":[]}' >"$output" ;;
    *) return 1 ;;
  esac
}
verify_lease() { :; }
run_capture() {
  [[ "$*" == *'patch externalsecret retrieval-credentials --type=json --patch-file '* ]] || return 1
  printf 'refresh\\n' >>"$WORKDIR/operations"
  cp "$WORKDIR/provisioned-secrets.json" "$WORKDIR/secrets.json"
  jq '.items[0].status.conditions[0].reason="SecretSynced"' "$WORKDIR/external.json" >"$WORKDIR/next.json"
  mv "$WORKDIR/next.json" "$WORKDIR/external.json"
}
passes=0
sleep() {
  passes=$((passes+1)); SECONDS=$((passes*10))
  ((passes<4)) || return 1
  if ((passes==2)); then
    jq '.items[0].status.conditions[0] |= (.status="True"|.reason="Provisioned")' "$WORKDIR/claims.json" >"$WORKDIR/next.json"
    mv "$WORKDIR/next.json" "$WORKDIR/claims.json"
    jq '.items[0].status |= (.readyReplicas=1|.availableReplicas=1)' "$WORKDIR/deployments.json" >"$WORKDIR/next.json"
    mv "$WORKDIR/next.json" "$WORKDIR/deployments.json"
  fi
}
guard_status() {
  ((passes==2)) || return 1
  printf '{"ready":true}' >"$WORKDIR/guard-status.json"
}
native_startup
`);
  assert.equal(r.status,0,r.stderr);
  assert.equal(fs.readFileSync(dir+'/operations','utf8'),'refresh\n');
  const progress=fs.readFileSync(dir+'/events.jsonl','utf8');
  const reports=progress.trim().split('\n').map(JSON.parse).filter(e=>e.type==='ocm-credentials');
  assert.equal(reports.length,3);
  assert.equal(reports[0].pending[0].externalSecretReason,'SecretDeleted');
  assert.equal(reports[1].pending[0].present,true);
  assert.equal(reports[1].pending[0].claimReady,false);
  assert.equal(reports[2].ready,true);
  assert.ok(!progress.includes('private-password'));
});

test('bootstrap command retains the current hook failure and discards stale operation errors', t => {
  for(const hookFailure of [true,false]) {
    const dir=workspace(t,{
      'error.json':{status:'failed',code:'STALE',message:'earlier attempt'},
      'hook.sh':`if [[ "$HOOK_FAILURE" == true ]]; then
cat >"$WORKDIR/error.json" <<'JSON'
{"status":"failed","code":"OCM_CREDENTIALS_PENDING","message":"Native credentials are pending."}
JSON
fi
exit 1
`,
    });
    const r=bash(dir,'run 10 bash "$WORKDIR/hook.sh"',{HOOK_FAILURE:String(hookFailure)});
    assert.notEqual(r.status,0);
    const failure=JSON.parse(fs.readFileSync(dir+'/error.json'));
    assert.equal(failure.code,hookFailure?'OCM_CREDENTIALS_PENDING':'COMMAND_FAILED');
  }
});
