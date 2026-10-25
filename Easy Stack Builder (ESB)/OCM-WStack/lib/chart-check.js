'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {networkOverrides, networkValues} = require('./adapt');
const {fail} = require('./config');
const {redisMirror}=require('./argo');
const ocm=require('./ocm');

const SETS = ['storage','network','core','ocm-wstack'];
const SET_FILES = ['03_storage','04_network','05_core','06_ocm_wstack'];
const BOOTSTRAP = [
  ['observability','INFRA/observability/opentelemtry','observability'],
  ['openbao','INFRA/security/openbao','security'],
  ['eso','INFRA/security/eso','security'],
  ['kyverno','INFRA/security/kyverno','security'],
  ['kubernetes-operator','INFRA/kubernetes-operator','security']
];
const CAPABILITIES = ['monitoring.coreos.com/v1','monitoring.coreos.com/v1/ServiceMonitor','monitoring.coreos.com/v1/PrometheusRule',
  'external-secrets.io/v1','argoproj.io/v1alpha1','gateway.networking.k8s.io/v1','gateway.networking.k8s.io/v1/Gateway',
  'cert-manager.io/v1','resources.xfsc.io/v1alpha1'];

async function exists(file) {try {await fs.access(file); return true;} catch(e) {if(e.code==='ENOENT')return false;throw e;}}
async function jsonFile(file, value) {await fs.writeFile(file,JSON.stringify(value),{mode:0o600});return file;}
function helmJson(stdout) {return JSON.parse(stdout.slice(stdout.indexOf('{')));}

// Let the installed Helm parse YAML using the same parser as the charts.
// No YAML implementation, runtime dependency or downloaded executable is bundled.
async function readYaml(r, directory, documents) {
  const parser=path.join(directory,'yaml-reader');
  await fs.mkdir(path.join(parser,'templates'),{recursive:true});
  await fs.writeFile(path.join(parser,'Chart.yaml'),'apiVersion: v2\nname: esb-yaml-reader\nversion: 1.0.0\n');
  await fs.writeFile(path.join(parser,'templates/documents.yaml'),'{{- $result := dict -}}{{- range $name, $text := .Values.documents -}}{{- $parsed := fromYaml $text -}}{{- if hasKey $parsed "Error" -}}{{ fail (printf "%s: %s" $name $parsed.Error) }}{{- end -}}{{- $_ := set $result $name $parsed -}}{{- end -}}{{ $result | toJson }}\n');
  const values=await jsonFile(path.join(directory,'documents.json'),{documents});
  return helmJson((await r.run('helm',['template','esb-yaml-reader',parser,'-f',values])).stdout);
}

async function plan(r, source, argoSource, c, directory) {
  const definitions={};
  for(let i=0;i<SETS.length;i++)definitions[SETS[i]]=await fs.readFile(path.join(source,`XFSC/Applicationsets/values/${SET_FILES[i]}-values.yaml`),'utf8');
  const sets=await readYaml(r,directory,definitions);
  const jobs=BOOTSTRAP.map(([release,chart,namespace])=>({release,chart,namespace,root:source,files:[],values:{},parameters:[]}));
  for(const target of ['infrastructure','ocm-wstack'])jobs.push({release:`${target}-namespace`,chart:'INFRA/app-management/app-namespace',namespace:'security',root:source,
    files:[`INFRA/app-management/app-namespace-values/${target==='infrastructure'?'infra':'ocm-wstack'}-values.yaml`],values:{},parameters:[]});
  // A reserved documentation IP exercises hostAliases rendering only. The real
  // alias is discovered after Envoy's Service exists, and never uses this IP.
  const overrides={...networkOverrides(c),...ocm.overrides(c)};
  for(let i=0;i<SETS.length;i++) {
    const name=SETS[i], set=sets[name];
    if(set.tag!=='main'||set.matrix?.enabled||!set.path?.endsWith('/*')||set.path.slice(0,-2).includes('*'))fail('CHART_PLAN',`Unsupported upstream ApplicationSet generator: ${name}.`);
    const excluded=new Set(set.excludes||[]);
    if(name==='network'&&!c.externalDns)excluded.add('INFRA/network/external-dns');
    const values={storageClass:c.actualStorageClass};
    if(name==='network')Object.assign(values,{profile:c.profile,domain:c.domain,email:c.email,excludes:[...excluded]},networkValues(c));
    if(name==='ocm-wstack')Object.assign(values,ocm.values(c));
    jobs.push({release:name,chart:'XFSC/Applicationsets/chart',namespace:set.namespace,root:source,files:[`XFSC/Applicationsets/values/${SET_FILES[i]}-values.yaml`],values,parameters:[]});
    const parent=set.path.slice(0,-2);
    for(const entry of (await fs.readdir(path.join(argoSource,parent),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const chart=`${parent}/${entry.name}`;
      if(!entry.isDirectory()||entry.name.startsWith('.')||excluded.has(chart))continue;
      if(!await exists(path.join(argoSource,chart,'Chart.yaml')))fail('CHART_PLAN',`ApplicationSet ${name} selects a directory without Chart.yaml: ${chart}.`);
      // ApplicationSet's basenameNormalized uses lowercase DNS-compatible characters.
      const release=entry.name.toLowerCase().replace(/[^a-z0-9.-]/g,'-');
      const parameters=[`global.storageClass=${c.actualStorageClass}`];
      const files=await exists(path.join(argoSource,chart,'values.yaml'))?[`${chart}/values.yaml`]:[];
      if(name==='network') {
        parameters.push(`global.domain=${c.domain}`,`external-dns.domainFilters[0]=${c.domain}`,`global.profile=${c.profile}`,`global.email=${c.email}`,`acme.email=${c.email}`);
        const profile=`${chart}/profiles/${c.profile}.yaml`;
        if(await exists(path.join(argoSource,profile)))files.push(profile);
      }
      jobs.push({release,chart,namespace:set.namespace,root:argoSource,files,values:chart==='INFRA/network/cert-manager'&&c.internalGatewayRouting?{'cert-manager':{hostAliases:[{ip:'192.0.2.1',hostnames:[c.tenantHost]}]}}:overrides[chart]||{},parameters,applicationSet:name});
    }
  }
  jobs.push({release:'esb-ocm-gateway',chart:'charts-gateway',namespace:'security',root:path.join(__dirname,'..'),files:[],parameters:[],values:{externalTrafficPolicy:c.externalTrafficPolicy}});
  if(c.runtimeEnabled)jobs.push({release:'ocm-orce-ui',chart:'charts-runtime',namespace:'ocm-wstack',root:path.join(__dirname,'..'),files:[],parameters:[],values:{host:c.tenantHost,gatewayPorts:[80,443,10080,10443],hostAliases:c.internalGatewayRouting?[{ip:'192.0.2.1',hostnames:[c.tenantHost]}]:[],listenerSetName:c.tenantRelease+'-xfsc-tenant-gateway',image:c.runtimeImage,storage:{class:c.actualStorageClass,orceSize:c.orceStorageSize,mongoSize:c.mongoStorageSize},mongo:{embedded:!c.useExternalMongo,externalPorts:[27017]},runtimeConfig:require('./runtime-install').runtimeConfig(c)}});
  jobs.push({release:c.tenantRelease,chart:'XFSC/tenant/chart',namespace:'ocm-wstack',root:source,files:['XFSC/tenant/values/tenant-ocm-wstack-values.yaml'],parameters:[],values:{tenant:{domain:c.domain,id:c.tenantId,group:c.tenantId,subdomain:c.tenantSubdomain},openbao:{transit:{mountPath:`ocm-wstack/${c.tenantId}`}}}});
  return jobs;
}

async function prepare(r, source, c, directory, {argoSource,argoRevision}={}) {
  r.emit({type:'phase',phase:'chart-preflight'});
  if(!argoSource) {
    await r.run('git',['-C',source,'fetch','--depth=1','origin','main'],{timeout:300000});
    argoRevision=(await r.run('git',['-C',source,'rev-parse','FETCH_HEAD'])).stdout.trim();
    if(!/^[a-f0-9]{40}$/.test(argoRevision))fail('CHART_PLAN','Could not resolve upstream main.');
    argoSource=path.join(directory,'argo-source');
    await r.run('git',['-C',source,'worktree','add','--detach',argoSource,argoRevision]);
  }
  const validationDir=path.join(directory,'chart-preflight');await fs.mkdir(validationDir,{recursive:true});
  const envoyDefaults=await readYaml(r,validationDir,{envoy:await fs.readFile(path.join(argoSource,'INFRA/network/envoy/values.yaml'),'utf8')});
  c.upstreamAnnotationKeys=Object.keys(envoyDefaults.envoy.envoyProxy?.service?.annotations||{});
  const jobs=await plan(r,source,argoSource,c,validationDir);
  const documents={};
  for(const job of jobs)documents[path.join(job.root,job.chart)]=await fs.readFile(path.join(job.root,job.chart,'Chart.yaml'),'utf8');
  const charts=await readYaml(r,validationDir,documents);
  const server=await r.json('kubectl',['version','-o','json']);
  const kubeVersion=server.serverVersion?.gitVersion;
  if(!/^v?\d+\.\d+\.\d+/.test(kubeVersion||''))fail('CHART_PLAN','Kubernetes server version is unavailable.');
  const repos=new Set(Object.values(charts).flatMap(chart=>(chart.dependencies||[]).map(d=>d.repository).filter(url=>/^https?:\/\//.test(url||''))));
  let repoNumber=0;
  for(const url of repos)await r.run('helm',['repo','add',`esb-audit-${repoNumber++}`,url],{timeout:120000});
  const errors=[],built=new Set(),results=[];
  for(let i=0;i<jobs.length;i++) {
    const job=jobs[i], location=path.join(job.root,job.chart);
    r.emit({type:'chart',chart:job.chart,release:job.release,step:i+1,total:jobs.length});
    try {
      if(!built.has(location)) {
        if(charts[location].dependencies?.length)await r.run('helm',['dependency','build',location],{timeout:300000});
        built.add(location);
      }
      const override=await jsonFile(path.join(validationDir,`values-${i}.json`),job.values);
      const args=['template',job.release,location,'--namespace',job.namespace,'--kube-version',kubeVersion,'--include-crds'];
      for(const api of CAPABILITIES)args.push('--api-versions',api);
      for(const file of job.files)args.push('-f',path.join(job.root,file));
      args.push('-f',override);
      for(const parameter of job.parameters)args.push('--set-string',parameter);
      // Render to private files, never to progress output (manifests can contain Secrets).
      args.push('--output-dir',path.join(validationDir,`render-${i}`));
      const rendered=await r.run('helm',args,{timeout:180000});
      if(/cannot overwrite table with non table|destination for .* is a table/.test(rendered.stderr))throw new Error(rendered.stderr);
      if(job.release==='observability')await require('./grafana').inspect(r,path.join(validationDir,`render-${i}`),validationDir,readYaml);
      if(job.chart===ocm.POLICY||job.chart===ocm.VERIFICATION)await ocm.inspect(r,path.join(validationDir,`render-${i}`),validationDir,readYaml,job.chart);
      // Exercise upgrade branches as well as first-install branches in Helm templates.
      await r.run('helm',[...args,'--is-upgrade'],{timeout:180000});
      if(job.chart===ocm.POLICY||job.chart===ocm.VERIFICATION)await ocm.inspect(r,path.join(validationDir,`render-${i}`),validationDir,readYaml,job.chart);
      const lockfile=path.join(location,'Chart.lock');
      results.push({chart:job.chart,release:job.release,namespace:job.namespace,applicationSet:job.applicationSet||null,
        dependencyLockSha256:await exists(lockfile)?crypto.createHash('sha256').update(await fs.readFile(lockfile)).digest('hex'):null});
    } catch(e) {
      if(r.signal?.aborted||e.code==='CANCELLED')throw e;
      const message=r.redact(e.message).slice(-1800);errors.push({chart:job.chart,release:job.release,message});
      r.emit({type:'chart-error',chart:job.chart,release:job.release,message});
    }
  }
  if(errors.length)fail('CHART_PREFLIGHT',`${errors.length} chart(s) failed before installation; no cluster resources were changed. ${errors.map(x=>`${x.chart}: ${x.message}`).join('\n')}`);
  await ocm.imagePreflight(r,validationDir);
  const current=(await r.run('git',['-C',source,'ls-remote','origin','refs/heads/main'],{timeout:60000})).stdout.trim().split(/\s+/)[0];
  if(current!==argoRevision)fail('UPSTREAM_MOVED','Upstream main changed during chart validation. Retry to validate its new revision. No installation was started.');
  const argoManifest=path.join(validationDir,'argo-install.yaml');
  await r.run('curl',['--fail','--silent','--show-error','--location','--max-time','120','--output',argoManifest,'https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml'],{timeout:130000});
  const originalManifest=await fs.readFile(argoManifest,'utf8');
  const manifest=redisMirror(originalManifest);
  await fs.writeFile(argoManifest,manifest,{mode:0o600});
  if(!manifest.includes('kind: CustomResourceDefinition')||!manifest.includes('name: argocd-server'))fail('ARGO_MANIFEST','Downloaded Argo manifest does not contain the expected resources. No installation was started.');
  const applicationCounts=Object.fromEntries(SETS.map(set=>[set,jobs.filter(j=>j.applicationSet===set).length]));
  const result={status:'charts-validated',argoRevision,kubeVersion,charts:results,applicationCounts,argoRedisRegistry:'docker.io/library/redis',argoManifestSha256:crypto.createHash('sha256').update(manifest).digest('hex'),liveDeploymentTested:false};
  r.env={...r.env,ESB_ARGO_MANIFEST:argoManifest,ESB_APPSET_COUNTS:JSON.stringify(applicationCounts)};
  r.emit({type:'chart-preflight-complete',argoRevision,chartCount:results.length});
  return result;
}

module.exports={prepare,plan,readYaml,helmJson};
