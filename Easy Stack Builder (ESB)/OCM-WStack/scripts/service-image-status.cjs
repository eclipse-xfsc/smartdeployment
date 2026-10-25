'use strict';
const {spawnSync}=require('node:child_process');
const registry='node-654e3bca7fbeeed18f81d7c7.ps-xaas.io';
const expected={
 'storage-service':registry+'/ocm-wstack/storage-service:1.2.4',
 'credential-retrieval-service':registry+'/ocm-wstack/credential-retrieval-service:1.1.5',
 'signer':registry+'/tsa/signer:2.3.5'
};
function summarize(deployments,pods){
 return Object.entries(expected).map(([name,image])=>{
  const d=deployments.items.find(x=>x.metadata.name===name),c=d?.spec.template.spec.containers.find(x=>x.name===name);
  return {service:name,expectedImage:image,configuredImage:c?.image||null,officialImageSelected:c?.image===image,imagePullPolicy:c?.imagePullPolicy||null,
   pods:pods.items.filter(x=>x.spec.containers.some(c=>c.name===name)).map(x=>{const s=x.status?.containerStatuses?.find(c=>c.name===name);return {name:x.metadata.name,image:x.spec.containers.find(c=>c.name===name).image,imageID:s?.imageID||null,ready:s?.ready===true,restarts:s?.restartCount||0};})};
 });
}
function collect(ns){
 if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ns))throw Error('Invalid namespace');
 const read=args=>{const r=spawnSync('kubectl',['-n',ns,'get',...args,'-o','json'],{encoding:'utf8',maxBuffer:16*1024*1024});if(r.status!==0)throw Error('Cannot read service image inventory');return JSON.parse(r.stdout);};
 return summarize(read(['deployments']),read(['pods']));
}
if(require.main===module){try{console.log(JSON.stringify({serviceImages:collect(process.argv[2]||'ocm-wstack')},null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={collect,summarize,expected};
