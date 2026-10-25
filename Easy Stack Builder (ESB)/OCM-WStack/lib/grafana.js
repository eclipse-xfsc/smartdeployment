'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {fail}=require('./config');
function validateWorkload(documents) {
  const workloads=Object.values(documents).filter(doc=>['Deployment','StatefulSet'].includes(doc?.kind)&&doc.metadata?.labels?.['app.kubernetes.io/name']==='grafana'&&doc.metadata?.labels?.['app.kubernetes.io/instance']==='observability');
  if(workloads.length!==1)fail('GRAFANA_STARTUP','Expected one rendered observability Grafana workload.');
  const pod=workloads[0].spec?.template?.spec;
  if(pod?.initContainers?.some(container=>container.name==='init-chown-data'))fail('GRAFANA_STARTUP','Grafana still includes the failing BusyBox chown init container.');
  const security=pod?.securityContext;
  if(security?.runAsNonRoot!==true||security.runAsUser!==472||security.runAsGroup!==472||security.fsGroup!==472||security.fsGroupChangePolicy!=='Always')fail('GRAFANA_STARTUP','Grafana must retain non-root UID/GID 472 and Kubernetes-managed PVC group permissions.');
  const grafana=pod.containers?.find(container=>container.name==='grafana');
  const mount=grafana?.volumeMounts?.find(volume=>volume.mountPath==='/var/lib/grafana');
  if(!mount||mount.readOnly||mount.subPath||mount.subPathExpr||!pod.volumes?.some(volume=>volume.name===mount.name&&volume.persistentVolumeClaim?.claimName))fail('GRAFANA_STARTUP','Grafana data must retain its writable PVC mount without a subPath.');
  return workloads[0].metadata.name;
}
function validate(documents) {
  const names=new Set(),uids=new Set(),defaults=new Set();let count=0;
  for(const doc of Object.values(documents)) {
    if(doc?.Error)fail('GRAFANA_DATASOURCES','Invalid rendered datasource YAML.');
    if(doc?.datasources==null)continue;
    if(!Array.isArray(doc.datasources))fail('GRAFANA_DATASOURCES','Rendered datasource list is invalid.');
    for(const ds of doc.datasources) {
      const org=ds.orgId??1;const name=org+':'+ds.name,uid=org+':'+ds.uid;
      if(!ds.name||names.has(name)||(ds.uid&&uids.has(uid)))fail('GRAFANA_DATASOURCES','Rendered Grafana datasource names or UIDs are duplicated.');
      names.add(name);if(ds.uid)uids.add(uid);
      if(ds.isDefault===true){if(defaults.has(org))fail('GRAFANA_DATASOURCES','More than one rendered Grafana datasource is default for the same organization.');defaults.add(org);}
      count++;
    }
  }
  if(count===0||!defaults.has(1))fail('GRAFANA_DATASOURCES','Grafana must have provisioned datasources and a default in organization 1.');
  return count;
}
async function inspect(r,root,directory,readYaml) {
  const sources={};let i=0;
  async function walk(dir) {
    for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())await walk(file);
      else if(/\.ya?ml$/.test(entry.name))for(const doc of (await fs.readFile(file,'utf8')).split(/^---\s*$/m))if(doc.trim())sources['manifest-'+i++]=doc;
    }
  }
  await walk(root);
  if(!Object.keys(sources).length)fail('GRAFANA_DATASOURCES','No observability manifests were rendered for datasource validation.');
  const manifests=await readYaml(r,directory,sources),provisioning={};
  validateWorkload(manifests);
  for(const [key,doc] of Object.entries(manifests)) {
    if(doc?.Error)fail('GRAFANA_DATASOURCES','Invalid observability manifest YAML.');
    if(!['ConfigMap','Secret'].includes(doc?.kind)||doc.metadata?.labels?.grafana_datasource!=='1')continue;
    for(const [name,value] of Object.entries(doc.data||{}))if(/\.ya?ml$/.test(name))provisioning[key+'/'+name]=doc.kind==='Secret'?Buffer.from(value,'base64').toString('utf8'):value;
    for(const [name,value] of Object.entries(doc.stringData||{}))if(/\.ya?ml$/.test(name))provisioning[key+'/'+name]=value;
  }
  if(!Object.keys(provisioning).length)fail('GRAFANA_DATASOURCES','No Grafana sidecar datasource definitions were rendered.');
  return validate(await readYaml(r,directory,provisioning));
}
module.exports={validate,validateWorkload,inspect};
