'use strict';
const {spawnSync}=require('node:child_process');
const services=['storage-service','credential-retrieval-service'];
function summarize(deployments,pods){
 return services.map(name=>{
  const d=deployments.items.find(x=>x.metadata.name===name),c=d?.spec.template.spec.containers.find(x=>x.name===name);
  return {service:name,configuredImage:c?.image||null,imagePullPolicy:c?.imagePullPolicy||null,
   geography:Object.fromEntries((c?.env||[]).filter(e=>['STORAGESERVICE_REGION','STORAGESERVICE_COUNTRY'].includes(e.name)).map(e=>[e.name,e.value??'(valueFrom)'])),
   pods:pods.items.filter(x=>x.spec.containers.some(c=>c.name===name)).map(x=>{const s=x.status?.containerStatuses?.find(c=>c.name===name);return {name:x.metadata.name,node:x.spec.nodeName||null,image:x.spec.containers.find(c=>c.name===name).image,imageID:s?.imageID||null,ready:s?.ready===true,restarts:s?.restartCount||0};})};
 });
}
function collect(ns){
 if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ns))throw Error('Invalid namespace');
 const read=args=>{const r=spawnSync('kubectl',['-n',ns,'get',...args,'-o','json'],{encoding:'utf8',maxBuffer:16*1024*1024});if(r.status!==0)throw Error('Cannot read service image inventory');return JSON.parse(r.stdout);};
 return summarize(read(['deployments','storage-service','credential-retrieval-service']),read(['pods']));
}
if(require.main===module){try{console.log(JSON.stringify({serviceImages:collect(process.argv[2]||'ocm-wstack')},null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={collect,summarize};
