'use strict';
const {spawnSync}=require('node:child_process');

// JSON Patch avoids strategic-merge failures on unrelated chart list entries.
// Guard the complete read against concurrent Deployment changes.
function plan(deployment,containerName,updates){
 const version=deployment.metadata?.resourceVersion;
 if(!version)throw new Error('Deployment resourceVersion is missing');
 const containers=deployment.spec?.template?.spec?.containers;
 if(!Array.isArray(containers))throw new Error('Deployment containers are missing');
 const matches=containers.map((c,i)=>c.name===containerName?i:-1).filter(i=>i>=0);
 if(matches.length!==1)throw new Error('Expected exactly one named container: '+containerName);
 const i=matches[0],current=containers[i].env??[];
 if(!Array.isArray(current))throw new Error('Container env must be an array');
 const env=current.filter(e=>!Object.hasOwn(updates,e.name));
 for(const [name,value] of Object.entries(updates)){
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||typeof value!=='string')throw new Error('Invalid environment update');
  env.push({name,value});
 }
 if(JSON.stringify(current)===JSON.stringify(env))return [];
 return [{op:'test',path:'/metadata/resourceVersion',value:version},
  {op:'add',path:`/spec/template/spec/containers/${i}/env`,value:env}];
}
function kubectl(args,input){
 const r=spawnSync('kubectl',args,{input,encoding:'utf8',maxBuffer:8*1024*1024});
 if(r.error)throw r.error;
 if(r.status!==0)throw new Error(r.stderr.trim()||'kubectl failed');
 return r.stdout;
}
function apply(namespace,deployment,container,updates,run=kubectl){
 const obj=JSON.parse(run(['-n',namespace,'get','deployment',deployment,'-o','json']));
 const patch=plan(obj,container,updates);
 if(!patch.length)return false;
 run(['-n',namespace,'patch','deployment',deployment,'--type=json','--patch-file=/dev/stdin'],JSON.stringify(patch));
 return true;
}
module.exports={plan,apply};
if(require.main===module){
 try{
  const [namespace,deployment,container,...pairs]=process.argv.slice(2);
  if(!namespace||!deployment||!container||!pairs.length)throw new Error('Usage: deployment-env.cjs NAMESPACE DEPLOYMENT CONTAINER NAME=value ...');
  const updates=Object.create(null);
  for(const pair of pairs){const at=pair.indexOf('=');if(at<1)throw new Error('Expected NAME=value');updates[pair.slice(0,at)]=pair.slice(at+1);}
  console.log(apply(namespace,deployment,container,updates)?'Deployment environment updated':'Deployment environment already configured');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
