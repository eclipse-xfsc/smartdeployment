#!/usr/bin/env node
'use strict';
// Test double only: no shell-outs and no Kubernetes/network access.
const fs=require('node:fs');
const path=require('node:path');
const cmd=path.basename(process.argv[1]),args=process.argv.slice(2);
const statePath=process.env.ESB_TEST_STATE,logPath=process.env.ESB_TEST_CALLS;
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
const record={command:cmd,args,cwd:process.cwd()};
for(const [key,file] of [['network',process.env.ESB_NETWORK_VALUES],['dns',process.env.ESB_DNS_SECRET_FILE]])if(file&&fs.existsSync(file))record[key]=JSON.parse(fs.readFileSync(file,'utf8'));
fs.appendFileSync(logPath,JSON.stringify(record)+'\n');
const out=x=>process.stdout.write(typeof x==='string'?x+'\n':JSON.stringify(x)+'\n');
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
function fail(message){process.stderr.write(message+'\n');process.exit(1);}
if(cmd==='helm'){
  if(args[0]==='version')out('v3.17.3+mock');
  if(args[0]==='upgrade'){
    const release=args[args.indexOf('-n')+2];
    // Tenant command places the release immediately after --install.
    const name=args[2]==='--timeout'?release:args[2];
    if(name===process.env.ESB_TEST_FAIL_RELEASE)fail('Simulated upstream Helm failure');
    if(['storage','network','core','ocm-wstack'].includes(name)&&!state.appsets.includes(name))state.appsets.push(name);
    if(name==='infrastructure-namespace')state.namespaces.push('infrastructure');
    if(name==='ocm-wstack-namespace')state.namespaces.push('ocm-wstack');
    save();out(`release ${name} installed`);
  }
  process.exit(0);
}
const a=[...args];let ns='default';
const n=a.indexOf('-n');if(n>=0){ns=a[n+1];a.splice(n,2);}
const nn=a.indexOf('--namespace');if(nn>=0){ns=a[nn+1];a.splice(nn,2);}
const [verb,kind,name]=a;
if(verb==='auth'){out('yes');process.exit(0);}
if(verb==='cluster-info'||verb==='rollout'){out('ready');process.exit(0);}
if(verb==='get'){
  if(kind==='nodes')out({items:[{spec:{providerID:'aws:///eu/test'},status:{conditions:[{type:'Ready',status:'True'}]}}]});
  else if(kind==='storageclasses')out({items:[{metadata:{name:'fast',annotations:{'storageclass.kubernetes.io/is-default-class':'true'}}}]});
  else if(kind==='namespace'&&name==='kube-system')out({metadata:{name,uid:'test-cluster-uid'}});
  else if(kind==='namespaces')out({items:state.namespaces.map(name=>({metadata:{name}}))});
  else if(kind==='configmap'||kind==='lease'){const v=state.objects[`${ns}/${kind}/${name}`];if(v)out(v);else if(!a.includes('--ignore-not-found'))fail('NotFound');}
  else if(kind==='applications.argoproj.io')out({items:state.appsets.map(set=>({metadata:{name:`${set}-component`,ownerReferences:[{kind:'ApplicationSet',name:set,controller:true}]},spec:{destination:{namespace:set==='ocm-wstack'?'ocm-wstack':'infrastructure'}},status:{sync:{status:'Synced',revision:'mock-main-sha'},health:{status:'Healthy'}}}))});
  else if(kind==='pods'){if(a.includes('--no-headers'))out('argocd-server 1/1 Running 0 1m');else out({items:[{metadata:{name:'credential-retrieval-service-1',namespace:'ocm-wstack'},status:{phase:'Running',containerStatuses:[{name:'retrieval',ready:true,restartCount:0,image:'upstream:1.1.5',imageID:'sha256:test'}]}}]});}
  else if(kind==='pvc')out({items:[]});
  else if(kind==='gateway')out({status:{addresses:[{type:'Hostname',value:'example.elb.amazonaws.com'}]}});
  else if(kind==='certificates')out({items:[{status:{conditions:[{type:'Ready',status:'True'}]}}]});
  else if(kind==='secret')out('secret/argocd-initial-admin-secret');
  else fail('Unimplemented fake get: '+args.join(' '));
  process.exit(0);
}
if(verb==='create'&&kind==='namespace') {out({apiVersion:'v1',kind:'Namespace',metadata:{name}});process.exit(0);}
if(['create','replace','apply'].includes(verb)){
  const f=a[a.indexOf('-f')+1];
  if(!f||f.startsWith('https://')){out('applied');process.exit(0);}
  const doc=JSON.parse(fs.readFileSync(f==='-'?0:f,'utf8'));
  if(doc.kind==='Lease')for(const field of ['acquireTime','renewTime']){
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(doc.spec[field]))fail('BadRequest: Lease '+field+' must use Kubernetes RFC3339Micro');
  }
  if(doc.kind==='Namespace') {if(!state.namespaces.includes(doc.metadata.name))state.namespaces.push(doc.metadata.name);}
  else {
    const key=`${doc.metadata.namespace||ns}/${doc.kind.toLowerCase()}/${doc.metadata.name}`;
    if(verb==='create'&&state.objects[key])fail('AlreadyExists');
    if(verb==='replace'&&doc.metadata.resourceVersion!==state.objects[key]?.metadata.resourceVersion)fail('Conflict');
    doc.metadata.resourceVersion=String(Number(state.objects[key]?.metadata.resourceVersion||0)+1);state.objects[key]=doc;
  }
  save();out(a.includes('json')?doc:`${doc.kind} configured`);process.exit(0);
}
fail('Unimplemented fake command: '+args.join(' '));
