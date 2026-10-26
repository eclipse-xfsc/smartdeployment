'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {ROOT,jq}=require('./deployment/helpers.cjs');
const source=path.resolve(process.argv[2]),dir=path.resolve(process.argv[3]),scenario=process.argv[4];
fs.mkdirSync(dir,{recursive:true});fs.cpSync(source,dir+'/source',{recursive:true});
cp.execFileSync('git',['apply',ROOT+'/deployment/upstream.patch'],{cwd:dir+'/source'});
function yaml(file){return JSON.parse(cp.execFileSync('python3',['-c','import sys,yaml,json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))',source+'/'+file],{encoding:'utf8'}));}
const c=structuredClone(require('./deployment/fixtures/chart-plan.json').config);
c.runtimeImage='ecofacis/xfsc-orce:2.0.15';
c.actualProvider=scenario;c.provider=scenario;c.actualDns='disabled';c.externalDns=false;
c.profile=scenario==='hetzner'?'hetzner':'generic';c.lbLocation=scenario==='hetzner'?'hel1':'';
if(scenario==='generic'){c.runtimeServices={didcomm:'http://external.example:9090'};c.useExternalMongo=true;c.publicDashboards=true;c.tenantId='company_one';c.tenantSubdomain='company-one';c.tenantHost='company-one.example.com';c.tenantUrl='https://company-one.example.com';}
if(scenario==='hetzner'){c.externalDns=true;c.actualDns='hetzner';}
if(scenario==='ionos'){c.externalDns=true;c.actualDns='ionos';c.profile='ionos';}
c.upstreamAnnotationKeys=Object.keys(yaml('INFRA/network/envoy/values.yaml').envoyProxy.service.annotations||{});
c.resolvedLbAnnotations=jq('provider_annotations',c);
const defaults=jq('$a * $b',{}, {a:yaml('XFSC/tenant/chart/values.yaml'),b:yaml('XFSC/tenant/values/tenant-ocm-wstack-values.yaml')});
fs.writeFileSync(dir+'/tenant-values.json',JSON.stringify(jq('tenant_values($defaults)',c,{defaults})));
fs.writeFileSync(dir+'/config.json',JSON.stringify(c));fs.writeFileSync(dir+'/credentials.json','{}');
const sets={};for(const [k,f] of Object.entries({storage:'03_storage',network:'04_network',core:'05_core','ocm-wstack':'06_ocm_wstack'}))sets[k]=yaml('XFSC/Applicationsets/values/'+f+'-values.yaml');
fs.writeFileSync(dir+'/appsets.json',JSON.stringify(sets));
const shell=`set -Eeuo pipefail
DEPLOYMENT="$ROOT/deployment"
CONFIG="$WORKDIR/config.json"
CREDENTIALS="$WORKDIR/credentials.json"
TIMEOUT_SECONDS=60
exec 3>"$WORKDIR/events.jsonl"
source "$DEPLOYMENT/common.sh"
load_libraries
SOURCE="$WORKDIR/source"
ARGO_SOURCE="$AUDIT_SOURCE"
write_values
chart_plan
`;
cp.execFileSync('bash',['-c',shell],{cwd:ROOT,env:{...process.env,ROOT,WORKDIR:dir,AUDIT_SOURCE:source},timeout:60000});
const jobs=JSON.parse(fs.readFileSync(dir+'/chart-jobs.json'));
if(c.externalDns){
 const version=require('../upstream-lock.json').helmPins['external-dns'];const archive=source+'/INFRA/network/external-dns/charts/external-dns-'+version+'.tgz';
 const frozen=dir+'/frozen';fs.mkdirSync(frozen,{recursive:true});cp.execFileSync('tar',['--no-same-owner','-xzf',archive,'-C',frozen]);
 const job=jobs.find(j=>j.chart==='INFRA/network/external-dns');Object.assign(job,{root:frozen,chart:'external-dns',files:[],parameters:[],values:jq('dns_values($lock)',c,{lock:require('../upstream-lock.json')})});
}
fs.writeFileSync(dir+'/jobs.json',JSON.stringify(jobs,null,2));
