#!/usr/bin/env node
'use strict';
// Test double only: no shell-outs and no Kubernetes/network access.
const fs=require('node:fs');
const path=require('node:path');
const cmd=path.basename(process.argv[1]),args=process.argv.slice(2);
let explicitConfig='',explicitContext='';
for(const flag of ['--kubeconfig','--context','--kube-context']) {
 const at=args.indexOf(flag);if(at>=0){if(flag==='--kubeconfig')explicitConfig=args[at+1];else explicitContext=args[at+1];args.splice(at,2);}
}
const statePath=process.env.ESB_TEST_STATE,logPath=process.env.ESB_TEST_CALLS;
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
const record={command:cmd,args,cwd:process.cwd(),qps:process.env.HELM_QPS,burst:process.env.HELM_BURST_LIMIT,explicitConfig,explicitContext,helmTokenOverride:process.env.HELM_KUBETOKEN,kubeconfigSha256:explicitConfig?require('node:crypto').createHash('sha256').update(fs.readFileSync(explicitConfig)).digest('hex'):null};
for(const [key,file] of [['network',process.env.ESB_NETWORK_VALUES],['ocm',process.env.ESB_OCM_VALUES],['dns',process.env.ESB_DNS_SECRET_FILE]])if(file&&fs.existsSync(file))record[key]=JSON.parse(fs.readFileSync(file,'utf8'));
if(cmd==='kubectl'&&args.includes('apply')&&args.some(a=>a.endsWith('argo-install.yaml')))record.argoRedisImage=fs.readFileSync(args[args.indexOf('-f')+1],'utf8').match(/image: (.*redis:.*)/)?.[1];
fs.appendFileSync(logPath,JSON.stringify(record)+'\n');
const out=x=>process.stdout.write(typeof x==='string'?x+'\n':JSON.stringify(x)+'\n');
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
function fail(message){process.stderr.write(message+'\n');process.exit(1);}
if(cmd==='git') {
  if(args.includes('rev-parse')||args.includes('ls-remote'))out('739606691ecff72b3a40404a19fce44d9c22b0ee');
  else if(args.includes('worktree'))fs.cpSync(process.env.ESB_TEST_SOURCE,args[args.indexOf('--detach')+1],{recursive:true});
  else if(!args.includes('fetch'))fail('Unimplemented fake git');
  process.exit(0);
}
if(cmd==='curl') {
  if(args.at(-1).includes('/v2/tsa/policy/')) {
    if(process.env.ESB_TEST_BAD_POLICY_IMAGE==='true')fail('HTTP 400 Bad Request');
    fs.writeFileSync(args[args.indexOf('--output')+1],args.includes('--head')?'HTTP/1.1 200 OK\n':JSON.stringify({schemaVersion:2,config:{mediaType:'application/vnd.oci.image.config.v1+json'},layers:[]}));process.exit(0);
  }
  fs.writeFileSync(args[args.indexOf('--output')+1],'kind: CustomResourceDefinition\n---\nkind: Deployment\nmetadata:\n  name: argocd-server\nspec:\n  template:\n    spec:\n      containers:\n        - name: redis\n          image: public.ecr.aws/docker/library/redis:8.2.3-alpine\n');
  process.exit(0);
}
if(cmd==='helm'){
  state.releases ||= {};state.attempts ||= {};
  if(args[0]==='status') {
    const key=args[args.indexOf('-n')+1]+'/'+args[1];
    if(!state.releases[key])fail('Error: release: not found');
    out({info:{status:state.releases[key]}});process.exit(0);
  }
  if(args[0]==='version')out('v3.17.3+mock');
  if(args[0]==='template') {
    if(args[1]==='esb-yaml-reader') {
      const input=fs.readFileSync(args[args.indexOf('-f')+1],'utf8');
      out(require('node:child_process').execFileSync('python3',['-c','import sys,json,yaml; print(json.dumps({k:yaml.safe_load(v) for k,v in json.load(sys.stdin)["documents"].items()}))'],{input,encoding:'utf8'}).trim());
    } else if(args[1]==='observability'&&args.includes('--output-dir')) {
      const root=args[args.indexOf('--output-dir')+1];fs.mkdirSync(root,{recursive:true});
      const ds=[{name:'Prometheus',uid:'prometheus',isDefault:true}];
      if(process.env.ESB_TEST_BAD_DATASOURCES==='true')ds.push({name:'Other',uid:'other',isDefault:true});
      fs.writeFileSync(path.join(root,'datasources.yaml'),JSON.stringify({kind:'ConfigMap',metadata:{labels:{grafana_datasource:'1'}},data:{'datasources.yaml':JSON.stringify({apiVersion:1,datasources:ds})}}));
    } else if(args[1]===process.env.ESB_TEST_BAD_CHART)fail('Simulated real-template rejection');
    else if(['policy-chart','credential-verification-service-chart'].includes(args[1])&&args.includes('--output-dir')) {
      const root=args[args.indexOf('--output-dir')+1];fs.mkdirSync(root,{recursive:true});
      const policy=args[1]==='policy-chart';
      const env=policy?[{name:'NATS_ADDR',value:'nats://nats.infrastructure.svc.cluster.local:4222'}]:[
        {name:'CREDENTIALVERIFICATION_SIGNINGKEY',valueFrom:{secretKeyRef:{name:'signing',key:'signing-key'}}},
        {name:'CREDENTIALVERIFICATION_CASSANDRAPASSWORD',valueFrom:{secretKeyRef:{name:'esb-credential-verification-cassandra',key:'cassandra-password'}}},
        {name:'CREDENTIALVERIFICATION_CASSANDRAHOSTS',value:'cassandra.infrastructure.svc.cluster.local'},
        {name:'CREDENTIALVERIFICATION_MESSAGING_NATS_URL',value:'nats://nats.infrastructure.svc.cluster.local:4222'}];
      if(process.env.ESB_TEST_BAD_OCM_VALUES==='true')env.push({name:'STALE_HOST',value:'nats.NAMESPACE.svc.cluster.local'});
      fs.writeFileSync(path.join(root,'deployment.yaml'),JSON.stringify({kind:'Deployment',spec:{template:{spec:{containers:[{name:policy?'policy':'credential-verification-service',image:policy?'node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/tsa/policy:1.0.0':'verification:main',ports:[{name:'http',containerPort:8080}],env}]}}}}));
      if(policy)fs.writeFileSync(path.join(root,'service.yaml'),JSON.stringify({kind:'Service',metadata:{name:'policy'},spec:{ports:[{port:8080,targetPort:8080}]}}));
    }
  }
  if(args[0]==='upgrade'){
    const release=args[args.indexOf('-n')+2];
    // Tenant command places the release immediately after --install.
    const name=args[2]==='--timeout'?release:args[2];
    const key=args[args.indexOf('-n')+1]+'/'+name;
    state.attempts[key]=(state.attempts[key]||0)+1;
    state.releases[key]='failed';save();
    if(name===process.env.ESB_TEST_FAIL_RELEASE)fail('Simulated upstream Helm failure');
    if(name===process.env.ESB_TEST_EOF_RELEASE&&state.attempts[key]===1) {
      if(process.env.ESB_TEST_PENDING==='true'){state.releases[key]='pending-install';save();}
      fail('Error: Post "https://api.example.test/apis/rbac.authorization.k8s.io/v1/clusterrolebindings?fieldManager=helm": EOF');
    }
    state.releases[key]='deployed';
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
if(verb==='version'){out({serverVersion:{gitVersion:'v1.34.2'}});process.exit(0);}
if(verb==='config'&&kind==='view'){
 out({'current-context':'uploaded-context',contexts:[{name:'uploaded-context',context:{user:'uploaded-user',cluster:'uploaded-cluster'}}],users:[{name:'uploaded-user',user:process.env.ESB_TEST_EMPTY_AUTH==='true'?{}:{token:'REDACTED'}}],clusters:[{name:'uploaded-cluster',cluster:{server:'https://uploaded.example.test'}}]});process.exit(0);
}
if(verb==='auth'&&kind==='whoami'){out({status:{userInfo:{username:'uploaded-admin',groups:['system:masters']}}});process.exit(0);}
if(verb==='auth'){if(process.env.ESB_TEST_ARGO_FORBIDDEN==='true'&&a.includes('applications.argoproj.io')){out('no');process.exit(1);}out('yes');process.exit(0);}
if(verb==='rollout'&&a.includes('statefulset/openbao'))fail('error: rollout status is only available for RollingUpdate strategy type');
if(verb==='wait'){
  if(ns==='ocm-wstack'&&a.includes('externalsecret/esb-credential-verification-cassandra')){out('condition met');process.exit(0);}
  if(ns!=='security'||!a.includes('pod/openbao-0')||!a.includes('--for=condition=Ready'))fail('Unexpected wait target');
  if(process.env.ESB_TEST_OPENBAO_UNREADY==='true')fail('error: timed out waiting for the condition on pods/openbao-0');
  out('pod/openbao-0 condition met');process.exit(0);
}
if(verb==='rollout'&&a.includes('deployment/argocd-redis')&&process.env.ESB_TEST_REDIS_UNREADY==='true')fail('redis rollout timed out');
if(verb==='cluster-info'||verb==='rollout'){out('ready');process.exit(0);}
if(verb==='get'&&kind==='--raw=/readyz'){out('ok');process.exit(0);}
if(verb==='get'&&kind==='--raw=/api/v1/namespaces/argocd/pods'){out({items:[{metadata:{name:'argocd-redis-test'},status:{phase:'Running',containerStatuses:[{name:'redis',ready:process.env.ESB_TEST_REDIS_UNREADY!=='true',state:{waiting:{reason:'ImagePullBackOff'}},image:'docker.io/library/redis:8.2.3-alpine'}]}}]});process.exit(0);}
if(verb==='get'&&kind.startsWith('--raw=/apis/')) {
  if(!state.argoInstalled)fail('Error from server (NotFound): the server could not find the requested resource');
  if(kind.includes('/customresourcedefinitions/')){out({status:{conditions:[{type:'Established',status:'True'}]}});process.exit(0);}
  if(kind.endsWith('/applications')) {
    state.applicationReads=(state.applicationReads||0)+1;save();
    if(process.env.ESB_TEST_ARGO_READ_EOF==='true'&&state.applicationReads===1)fail('Error: Get "https://api.example.test/apis/argoproj.io/v1alpha1/namespaces/argocd/applications": EOF');
    // Reuse the Application response below, without Kubernetes discovery.
    a[1]='applications.argoproj.io';
  } else fail('Unexpected raw read');
}
if(verb==='get'){
  if(kind==='nodes')out({items:[{spec:{providerID:'aws:///eu/test'},status:{conditions:[{type:'Ready',status:'True'}]}}]});
  else if(kind==='storageclasses')out({items:[{metadata:{name:'fast',annotations:{'storageclass.kubernetes.io/is-default-class':'true'}}}]});
  else if(kind==='namespace'&&name==='kube-system')out({metadata:{name,uid:'test-cluster-uid'}});
  else if(kind==='namespaces')out({items:state.namespaces.map(name=>({metadata:{name}}))});
  else if(kind==='configmap'||kind==='lease'){const v=state.objects[`${ns}/${kind}/${name}`];if(v)out(v);else if(!a.includes('--ignore-not-found'))fail('NotFound');}
  else if(kind==='applications.argoproj.io'||a[1]==='applications.argoproj.io')out({items:state.appsets.flatMap(set=>Array.from({length:JSON.parse(process.env.ESB_APPSET_COUNTS||'{}')[set]||1},(_,i)=>({metadata:{name:`${set}-component-${i}`,ownerReferences:[{kind:'ApplicationSet',name:set,controller:true}]},spec:{destination:{namespace:set==='ocm-wstack'?'ocm-wstack':'infrastructure'}},status:{sync:{status:'Synced',revision:'mock-main-sha'},health:{status:'Healthy'}}})))});
  else if(kind==='pods'){if(a.includes('--no-headers'))out('argocd-server 1/1 Running 0 1m');else out({items:[{metadata:{name:'credential-retrieval-service-1',namespace:'ocm-wstack'},status:{phase:'Running',containerStatuses:[{name:'retrieval',ready:true,restartCount:0,image:'upstream:1.1.5',imageID:'sha256:test'}]}}]});}
  else if(kind==='pvc')out({items:[]});
  else if(kind==='gateway')out({status:{addresses:[{type:'Hostname',value:'example.elb.amazonaws.com'}]}});
  else if(kind==='certificates')out({items:[{status:{conditions:[{type:'Ready',status:'True'}]}}]});
  else if(kind==='secret'||kind==='externalsecret'){
    const doc=state.objects[`${ns}/${kind}/${name}`];
    if(doc)out(doc);else if(!a.includes('--ignore-not-found'))out('secret/argocd-initial-admin-secret');
  }
  else fail('Unimplemented fake get: '+args.join(' '));
  process.exit(0);
}
if(verb==='create'&&kind==='namespace') {out({apiVersion:'v1',kind:'Namespace',metadata:{name}});process.exit(0);}
if(['create','replace','apply'].includes(verb)){
  const f=a[a.indexOf('-f')+1];
  if(!f||f.startsWith('https://')||f.endsWith('argo-install.yaml')){if(f?.endsWith('argo-install.yaml')){state.argoInstalled=true;save();}out('applied');process.exit(0);}
  const doc=JSON.parse(fs.readFileSync(f==='-'?0:f,'utf8'));
  if(doc.kind==='Secret'&&doc.stringData){doc.data=Object.fromEntries(Object.entries(doc.stringData).map(([k,v])=>[k,Buffer.from(v).toString('base64')]));delete doc.stringData;}
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
