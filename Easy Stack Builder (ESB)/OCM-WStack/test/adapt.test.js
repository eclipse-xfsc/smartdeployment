'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {adapt}=require('../lib/adapt');
const fixture=path.join(__dirname,'fixtures/upstream');

test('reviewed official source adapts without changing charts, service values, routes or main tracking',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-adapt-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.cp(fixture,dir,{recursive:true});await adapt(dir);
  const basic=await fs.readFile(path.join(dir,'basic-cluster-init.sh'),'utf8');
  const ocm=await fs.readFile(path.join(dir,'ocm-wstack-init.sh'),'utf8');
  assert.equal((ocm.match(/\.\/basic-cluster-init.sh/g)||[]).length,1);
  assert.match(basic,/set -Eeuo pipefail/);assert.match(basic,/ESB_HELM_UPGRADE[^\n]+upgrade --install/);assert.match(basic,/kubectl apply -f "\$ESB_DNS_SECRET_FILE"/);
  assert.doesNotMatch(basic,/--from-literal=token/);assert.match(basic,/-f "\$ESB_NETWORK_VALUES"/);
  const argo=await fs.readFile(path.join(dir,'argocd-bootstrap.sh'),'utf8');assert.doesNotMatch(argo,/password=\$|Admin Password:|base64 -d/);
  for(const script of ['basic-cluster-init.sh','ocm-wstack-init.sh','argocd-bootstrap.sh','check-applicationset.sh'])execFileSync('bash',['-n',path.join(dir,script)]);
  for(const unchanged of ['OCM W-Stack/Storage Service/values.yaml','OCM W-Stack/Credential Retrieval/values.yaml','XFSC/tenant/values/tenant-ocm-wstack-values.yaml','XFSC/Applicationsets/values/06_ocm_wstack-values.yaml','XFSC/tenant/chart/templates/httproute.yaml'])assert.equal(await fs.readFile(path.join(dir,unchanged),'utf8'),await fs.readFile(path.join(fixture,unchanged),'utf8'));
  assert.match(await fs.readFile(path.join(dir,'XFSC/tenant/chart/templates/tenant-registration.yaml'),'utf8'),/--fail-with-body/);
});
test('source drift fails before adapting any file',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-drift-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.cp(fixture,dir,{recursive:true});
  await fs.appendFile(path.join(dir,'check-applicationset.sh'),'\n# drift\n');
  await assert.rejects(adapt(dir),{code:'UPSTREAM_CONTRACT'});
  assert.equal(await fs.readFile(path.join(dir,'basic-cluster-init.sh'),'utf8'),await fs.readFile(path.join(fixture,'basic-cluster-init.sh'),'utf8'));
});
