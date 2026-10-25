'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {fail}=require('./config');
const RESOLVER='http://universal-resolver-service.infrastructure.svc.cluster.local:8080';
const IMAGE='node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/ocm-wstack/credential-retrieval-service:1.1.5';
const DIGEST='sha256:c6ff55eaff0624c9e3f94d23a823c9cbdb2b7235dc6d14180b359ad8e79176ae';
const CHECKSUM='8968c7a3719d337d84846d35aa370462e9977641cb2a876046ee82ade7bbb864';
const AUDIT='esb-retrieval-migration-recovery';
const DIRTY='migration V001 (create offerings table) is marked dirty';

async function resolver(r) {
 const s=await r.json('kubectl',['-n','infrastructure','get','service','universal-resolver-service','--ignore-not-found','-o','json']);
 if(!s?.spec?.ports?.some(x=>x.port===8080))fail('RESOLVER_SERVICE','Expected infrastructure/universal-resolver-service:8080 is absent. Check the current upstream resolver chart; OCM startup was not attempted.');
 r.emit({type:'ocm-startup',service:'universal-resolver',state:'configured',url:RESOLVER});
}
function ready(d) {
 const n=d?.spec?.replicas??1;
 return n>0&&d?.status?.observedGeneration>=d?.metadata?.generation&&d.status.updatedReplicas===n&&d.status.readyReplicas===n&&d.status.availableReplicas===n&&d.status.replicas===n;
}
function environment(d) {
 return Object.fromEntries((d.spec.template.spec.containers.find(x=>x.name==='credential-retrieval-service')?.env||[]).map(x=>[x.name,x]));
}
function recoveryContract(d,pods) {
 const container=d.spec.template.spec.containers.find(x=>x.name==='credential-retrieval-service');
 if(container?.image!==IMAGE||d.status?.availableReplicas>0)fail('RETRIEVAL_RECOVERY_CONTRACT','Recovery requires the reviewed, unavailable Retrieval 1.1.5 deployment. No migration state was changed.');
 const e=environment(d),user=e.CREDENTIALRETRIEVAL_CASSANDRA_USER?.valueFrom?.secretKeyRef,pw=e.CREDENTIALRETRIEVAL_CASSANDRA_PASSWORD?.valueFrom?.secretKeyRef;
 if(e.CREDENTIALRETRIEVAL_MIGRATIONS_TABLE?.value!=='retrieval_schema_migration'||
    e.CREDENTIALRETRIEVAL_CASSANDRA_HOSTS?.value!=='cassandra.infrastructure.svc.cluster.local'||
    !['','ocm',undefined].includes(e.CREDENTIALRETRIEVAL_CASSANDRA_KEYSPACE?.value)||
    !['9042',undefined].includes(e.CREDENTIALRETRIEVAL_CASSANDRA_PORT?.value)||
    !['2m',undefined].includes(e.CREDENTIALRETRIEVAL_MIGRATIONS_TIMEOUT?.value)||
    !['true',undefined].includes(e.CREDENTIALRETRIEVAL_MIGRATIONS_ENABLED?.value)||
    !user?.name||user.name!==pw?.name||user.key!=='username'||pw.key!=='password')fail('RETRIEVAL_RECOVERY_CONTRACT','Retrieval database configuration differs from the reviewed native migration contract. No migration state was changed.');
 if(!pods.length||pods.some(p=>{
   const c=p.spec?.containers?.find(x=>x.name==='credential-retrieval-service');
   const s=p.status?.containerStatuses?.find(x=>x.name==='credential-retrieval-service');
   const last=s?.state?.terminated||s?.lastState?.terminated;
   if(s?.imageID&&!s.imageID.endsWith('@'+DIGEST))fail('RETRIEVAL_RECOVERY_IMAGE','The running Retrieval digest differs from the reviewed migration recovery image. No migration state was changed.');
   return p.metadata.deletionTimestamp||c?.image!==IMAGE||!s?.imageID||s.ready||s.state?.running||last?.exitCode!==1;
 }))return null; // A native migration may still be running. Wait, never compete.
 return {secret:user.name};
}
async function saveEvidence(r,record) {
 const old=await r.json('kubectl',['-n','ocm-wstack','get','configmap',AUDIT,'--ignore-not-found','-o','json']);
 if(old&&old.metadata?.labels?.['app.kubernetes.io/managed-by']!=='esb-ocmwstack')fail('OWNERSHIP','Migration recovery evidence ConfigMap belongs to another owner.');
 const doc={apiVersion:'v1',kind:'ConfigMap',metadata:{name:AUDIT,namespace:'ocm-wstack',labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}},data:{'recovery.json':JSON.stringify(record)}};
 await r.run('kubectl',['-n','ocm-wstack','apply','--field-manager=esb-ocmwstack','-f','-'],{input:JSON.stringify(doc)});
}
async function repair(r,d,pods) {
 const contract=recoveryContract(d,pods);if(!contract)return {state:'settling'};
 const secret=await r.json('kubectl',['-n','ocm-wstack','get','secret',contract.secret,'-o','json']);
 const decode=key=>{
  if(!secret?.data?.[key])fail('RETRIEVAL_CREDENTIALS','Native Retrieval database Secret is incomplete.');
  const value=Buffer.from(secret.data[key],'base64').toString('utf8');r.secrets.push(secret.data[key],value);return value;
 };
 const username=decode('username'),password=decode('password');
 const list=await r.json('kubectl',['-n','infrastructure','get','pods','-l','app.kubernetes.io/name=cassandra','-o','json']);
 const database=(list?.items||[]).find(p=>!p.metadata.deletionTimestamp&&p.status?.containerStatuses?.some(x=>x.name==='cassandra'&&x.ready));
 if(!database)fail('RETRIEVAL_RECOVERY_DATABASE','No ready native Cassandra container is available for guarded migration recovery.');
 const [script,cql]=await Promise.all([fs.readFile(path.join(__dirname,'../scripts/retrieval-recovery.py'),'utf8'),fs.readFile(path.join(__dirname,'../scripts/retrieval-v001.cql'),'utf8')]);
 if(crypto.createHash('sha256').update(cql).digest('hex')!==CHECKSUM)fail('RETRIEVAL_MIGRATION_CHECKSUM','Packaged native migration checksum changed.');
 const config={username,password,host:'cassandra.infrastructure.svc.cluster.local',port:9042,cql,checksum:CHECKSUM};
 async function execute(mode,expected) {
  const result=await r.run('kubectl',['-n','infrastructure','exec','-i',database.metadata.name,'-c','cassandra','--','python3','-c',script],{input:JSON.stringify({...config,mode,expected}),timeout:180000,allowFailure:true});
  let out;try{out=JSON.parse(result.stdout.trim());}catch{fail('RETRIEVAL_RECOVERY_TOOL','Native Cassandra recovery helper returned no valid result. Migration readiness has not been verified.');}
  if(result.code!==0||out.state==='blocked')fail('RETRIEVAL_RECOVERY',out.message||'Native migration recovery was blocked. Existing data was retained.');
  return out;
 }
 const inspection=await execute('inspect');
 if(inspection.state!=='repairable')return inspection;
 const record={image:IMAGE,digest:DIGEST,checksum:CHECKSUM,checkedAt:new Date().toISOString(),...inspection};
 await saveEvidence(r,record);
 // Recheck the crashing image/config immediately before a database write.
 const latest=await r.json('kubectl',['-n','ocm-wstack','get','deployment',d.metadata.name,'-o','json']);
 const current=await r.json('kubectl',['-n','ocm-wstack','get','pods','-l','app.kubernetes.io/name=credential-retrieval-service','-o','json']);
 const again=recoveryContract(latest,current?.items||[]);
 if(!again)return {state:'settling'};
 if(again.secret!==contract.secret)fail('RETRIEVAL_RECOVERY_CONTRACT','Native credential reference changed during inspection.');
 const result=await execute('repair',inspection.before);
 await saveEvidence(r,{...record,...result,finishedAt:new Date().toISOString()});
 r.emit({type:'migration-recovery',service:'credential-retrieval',state:result.state,version:1,checksum:CHECKSUM,evidence:'ocm-wstack/'+AUDIT});
 return result;
}
async function stabilize(r,{timeoutSeconds=900,runtimeEnabled=true,runtimeServices={}}={}, {now=Date.now,sleep=delay}={}) {
 const targets=['credential-retrieval-service',...(runtimeEnabled&&!runtimeServices.didcomm?['didcomm-connector']:[])];
 const start=now();let last='',repaired=false;
 while(now()-start<timeoutSeconds*1000) {
  if(r.signal?.aborted)fail('CANCELLED','OCM startup cancelled; installed resources retained.');
  const workloads=await r.json('kubectl',['-n','ocm-wstack','get','deployments','-o','json']);
  const deployments=targets.map(name=>(workloads.items||[]).find(d=>d.metadata.name===name));
  const retrieval=deployments[0];
  if(retrieval&&retrieval.spec.strategy?.type!=='Recreate') {
   await r.run('kubectl',['-n','ocm-wstack','patch','deployment',retrieval.metadata.name,'--type=json','-p',JSON.stringify([
    {op:'test',path:'/metadata/resourceVersion',value:retrieval.metadata.resourceVersion},
    {op:'add',path:'/spec/strategy',value:{type:'Recreate'}}
   ])]);
   r.emit({type:'ocm-startup',service:'credential-retrieval',state:'serialized-rollouts'});
   await sleep(1000,undefined,{signal:r.signal});continue;
  }
  if(deployments.every(ready))return;
  const statuses=targets.map((name,i)=>({name,ready:ready(deployments[i]),available:deployments[i]?.status?.availableReplicas||0}));
  const list=await r.json('kubectl',['-n','ocm-wstack','get','pods','-o','json']);
  const pods=(list.items||[]).filter(p=>targets.includes(p.metadata?.labels?.['app.kubernetes.io/name']));
  let dirty=false;
  for(const p of pods) {
   const name=p.metadata.labels['app.kubernetes.io/name'];
   const state=p.status?.containerStatuses?.find(x=>x.name===name);
   if(!state||state.ready||!state.restartCount)continue;
   const log=await r.run('kubectl',['-n','ocm-wstack','logs',p.metadata.name,'-c',name,'--tail=25','--previous'],{allowFailure:true,timeout:20000});
   const text=log.stdout||'';
   let reason=state.state?.waiting?.reason||'Restarting';
   if(name==='credential-retrieval-service'&&text.includes(DIRTY)){dirty=true;reason='RETRIEVAL_MIGRATION_DIRTY';}
   if(name==='didcomm-connector'&&text.includes('Resolver not available'))reason='DIDCOMM_RESOLVER_UNAVAILABLE';
   statuses.find(x=>x.name===name).reason=reason;
  }
  const key=JSON.stringify(statuses);
  if(key!==last){last=key;r.emit({type:'ocm-startup',phase:'ocm-wstack',services:statuses,elapsedSeconds:Math.floor((now()-start)/1000)});}
  if(dirty&&!repaired&&deployments[0]) {
   const outcome=await repair(r,deployments[0],pods.filter(p=>p.metadata.labels['app.kubernetes.io/name']==='credential-retrieval-service'));
   repaired=['repaired','not-needed'].includes(outcome.state);
  }
  await sleep(10000,undefined,{signal:r.signal});
 }
 fail('OCM_STARTUP',`Native OCM services did not become ready: ${last}. Existing services, credentials and volumes were retained.`);
}
module.exports={resolver,ready,recoveryContract,repair,stabilize,RESOLVER,IMAGE,DIGEST,CHECKSUM};
