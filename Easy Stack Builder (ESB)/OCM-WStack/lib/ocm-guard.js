'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {fail}=require('./config');
const NAME='esb-ocm-guard',NS='ocm-wstack',OWNER='esb-ocmwstack';
const labels={'app.kubernetes.io/managed-by':OWNER,app:NAME};
function resources(image,files,apiEgress=[]){
 const metadata=(name=NAME,namespace=NS)=>({name,...(namespace?{namespace}:{}),labels});
 const role=(namespace,rules)=>({apiVersion:'rbac.authorization.k8s.io/v1',kind:'Role',metadata:metadata(NAME,namespace),rules});
 const binding=(namespace,kind='Role')=>({apiVersion:'rbac.authorization.k8s.io/v1',kind:kind==='Role'?'RoleBinding':'ClusterRoleBinding',metadata:metadata(NAME,namespace),roleRef:{apiGroup:'rbac.authorization.k8s.io',kind,name:NAME},subjects:[{kind:'ServiceAccount',name:NAME,namespace:NS}]});
 const checksum=crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
 return [
  {apiVersion:'v1',kind:'ServiceAccount',metadata:metadata()},
  {apiVersion:'v1',kind:'ConfigMap',metadata:metadata(),data:files},
  role(NS,[{apiGroups:[''],resources:['secrets','pods'],verbs:['get','list']},{apiGroups:['apps'],resources:['deployments','replicasets'],verbs:['get','list']},{apiGroups:['apps'],resources:['deployments'],verbs:['patch']},{apiGroups:['resources.xfsc.io'],resources:['resourceclaims'],verbs:['get','list']},{apiGroups:['external-secrets.io'],resources:['externalsecrets'],verbs:['get','list']}]),
  binding(NS),
  role('infrastructure',[{apiGroups:[''],resources:['secrets'],resourceNames:['redis-root-auth'],verbs:['get']},{apiGroups:[''],resources:['endpoints'],resourceNames:['nats'],verbs:['get']}]),
  binding('infrastructure'),
  {apiVersion:'rbac.authorization.k8s.io/v1',kind:'ClusterRole',metadata:metadata(NAME,null),rules:[{apiGroups:['resources.xfsc.io'],resources:['resourceproviders'],resourceNames:['redis'],verbs:['get']}]},
  binding(null,'ClusterRole'),
  {apiVersion:'apps/v1',kind:'Deployment',metadata:metadata(),spec:{replicas:1,strategy:{type:'Recreate'},selector:{matchLabels:{app:NAME}},template:{metadata:{labels,annotations:{'esb.xfsc.io/source':checksum}},spec:{serviceAccountName:NAME,securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,seccompProfile:{type:'RuntimeDefault'}},containers:[{name:NAME,image,imagePullPolicy:'IfNotPresent',command:['node','/guard/scripts/ocm-guard.js'],securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},resources:{requests:{cpu:'25m',memory:'48Mi'},limits:{cpu:'250m',memory:'128Mi'}},ports:[{name:'http',containerPort:8080}],readinessProbe:{httpGet:{path:'/health',port:'http'},periodSeconds:5},livenessProbe:{httpGet:{path:'/health',port:'http'},initialDelaySeconds:10,periodSeconds:20},volumeMounts:[{name:'source',mountPath:'/guard',readOnly:true}]}],volumes:[{name:'source',configMap:{name:NAME,items:[{key:'ocm-guard.js',path:'scripts/ocm-guard.js'},{key:'ocm-guard-core.js',path:'lib/ocm-guard-core.js'}]}}]}}}},
  {apiVersion:'v1',kind:'Service',metadata:metadata(),spec:{type:'ClusterIP',selector:{app:NAME},ports:[{name:'http',port:8080,targetPort:'http'}]}},
  {apiVersion:'networking.k8s.io/v1',kind:'NetworkPolicy',metadata:metadata(),spec:{podSelector:{matchLabels:{app:NAME}},policyTypes:['Ingress','Egress'],ingress:[{ports:[{protocol:'TCP',port:8080}]}],egress:[{ports:[{protocol:'UDP',port:53},{protocol:'TCP',port:53}]},...apiEgress,{to:[{namespaceSelector:{matchLabels:{'kubernetes.io/metadata.name':'infrastructure'}}}],ports:[{protocol:'TCP',port:6379},{protocol:'TCP',port:4222},{protocol:'TCP',port:8222}]}]}}
 ];
}
async function install(r,image=r.env?.ESB_GUARD_IMAGE){
 if(typeof image!=='string'||!image||!/^[-a-zA-Z0-9_./:@]+$/.test(image)||image.endsWith(':latest'))fail('GUARD_IMAGE','A tagged Node-capable ORCE image is required for the reconciler.');
 const files=Object.fromEntries(await Promise.all([['ocm-guard.js','../scripts/ocm-guard.js'],['ocm-guard-core.js','ocm-guard-core.js']].map(async([key,file])=>[key,await fs.readFile(path.join(__dirname,file),'utf8')])));
 const docs=resources(image,files);
 // Inspect every name before the first write, including cluster RBAC.
 for(const d of docs){const old=await r.json('kubectl',[...(d.metadata.namespace?['-n',d.metadata.namespace]:[]),'get',d.kind,d.metadata.name,'--ignore-not-found','-o','json']);if(old&&old.metadata?.labels?.['app.kubernetes.io/managed-by']!==OWNER)fail('OWNERSHIP','An OCM reconciler resource belongs to another owner.');}
 const apiEgress=await require('./kube-api-egress').discover(r);
 docs.find(d=>d.kind==='NetworkPolicy').spec.egress.splice(1,0,...apiEgress);
 await r.run('kubectl',['apply','--field-manager=esb-ocmwstack','-f','-'],{input:JSON.stringify({apiVersion:'v1',kind:'List',items:docs})});
 r.emit({type:'ocm-guard',state:'installed',image,apiPorts:apiEgress.map(rule=>rule.ports[0].port)});
}
async function status(r){
 const result=await r.run('kubectl',['get','--raw',`/api/v1/namespaces/${NS}/services/http:${NAME}:8080/proxy/status`],{timeout:20000,allowFailure:true});
 if(result.code!==0)return {ready:false,code:'GUARD_UNREACHABLE'};
 let d;try{d=JSON.parse(result.stdout);}catch{return {ready:false,code:'GUARD_INVALID_RESPONSE'};}
 const core=require('./ocm-guard-core'),expected=core.SUBJECTS;
 if(d.ready!==true)return {...d,ready:false};
 const [deployments,pods,replicasets]=await Promise.all(['deployments','pods','replicasets'].map(kind=>r.json('kubectl',['-n',NS,'get',kind,'-o','json'],{timeout:20000})));
 const complete=Object.entries(expected).every(([name,subjects])=>{
  const workload=deployments.items?.find(x=>x.metadata.name===name),service=d.services?.find(s=>s.name===name);
  if(!core.ready(workload)||!service?.ready||service.deploymentUid!==workload.metadata.uid||service.generation!==workload.metadata.generation)return false;
  const current=core.ownedPods(workload,pods.items||[],replicasets.items||[]).map(p=>p.metadata.uid).sort();
  return current.length===(workload.spec.replicas??1)&&JSON.stringify(current)===JSON.stringify(service.podUids)&&subjects.every(x=>service.subjects?.includes(x));
 });
 const verificationReady=core.verificationNatsReady(deployments.items?.find(x=>x.metadata.name===core.VERIFICATION),pods.items||[],replicasets.items||[]);
 if(!verificationReady)return {...d,ready:false,code:'VERIFICATION_NATS_CONTRACT',verificationNats:{ready:false}};
 const age=Date.now()-Date.parse(d.checkedAt);
 return {...d,ready:d.ready===true&&d.credentials?.synchronized===true&&d.redis?.authenticated===true&&complete&&age>=0&&age<60000};
}
module.exports={NAME,NS,resources,install,status};
