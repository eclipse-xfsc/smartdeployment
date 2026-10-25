'use strict';
// Runs unchanged in the ESB-owned in-cluster reconciler. No third-party modules.
const net=require('node:net'),tls=require('node:tls'),crypto=require('node:crypto');
const NS='ocm-wstack',ANNOTATION='esb.xfsc.io/credentials',RECOVERY='esb.xfsc.io/nats-recovery';
const BRIDGE='pre-authorization-bridge',WELLKNOWN='well-known-service';
const VERIFICATION='credential-verification-service';
// These four non-secret values are written by the native NATS injector.
// Argo excludes only these entries; the guard checks their values and presence.
const VERIFICATION_NATS_ENV=Object.freeze({
 CREDENTIALVERIFICATION_NATS_HOST:'nats.infrastructure.svc.cluster.local',
 CREDENTIALVERIFICATION_NATS_PORT:'4222',
 CREDENTIALVERIFICATION_NATS_REQUEST_TIMEOUT:'10s',
 CREDENTIALVERIFICATION_MESSAGING_NATS_URL:'nats://nats.infrastructure.svc.cluster.local:4222'
});
const SUBJECTS={
 [BRIDGE]:['auth.authorization.generate','auth.authorization.validate'],
 [WELLKNOWN]:['wellknown.issuer.registration','wellknown.issuer.metadata']
};
function blocked(code){throw Object.assign(new Error(code),{code});}
function ready(d){const n=d?.spec?.replicas??1;return n>0&&d?.status?.observedGeneration>=d?.metadata?.generation&&['replicas','updatedReplicas','readyReplicas','availableReplicas'].every(k=>d.status[k]===n);}
function decode(secret,key){const s=secret?.data?.[key];if(typeof s!=='string'||!s)blocked('CREDENTIAL_SECRET_INCOMPLETE');return Buffer.from(s,'base64').toString('utf8');}
function env(container){return Object.fromEntries((container?.env||[]).map(x=>[x.name,x]));}
function value(e,key,secrets){const item=e[key];if(item?.value!==undefined)return item.value;const ref=item?.valueFrom?.secretKeyRef;if(!ref)blocked('ENVIRONMENT_CONTRACT');return decode(secrets.get(ref.name),ref.key);}
function credentialDigest(d,secrets){
 const refs=new Map(),add=(name,key,optional=false)=>{if(!name)return;const secret=secrets.get(name);if(!secret&&!optional)blocked('CONSUMER_SECRET_PENDING');const keys=key?[key]:Object.keys(secret?.data||{}).sort();for(const k of keys){if(secret?.data?.[k]===undefined&&!optional)blocked('CONSUMER_SECRET_KEY_PENDING');refs.set(name+'/'+k,secret?.data?.[k]??null);}};
 const spec=d.spec.template.spec;
 for(const c of [...(spec.containers||[]),...(spec.initContainers||[])]){for(const x of c.env||[]){const r=x.valueFrom?.secretKeyRef;if(r)add(r.name,r.key,r.optional);}for(const x of c.envFrom||[]){const r=x.secretRef;if(r)add(r.name,null,r.optional);}}
 for(const v of spec.volumes||[]){if(v.secret){const r=v.secret;if(r.items)for(const i of r.items)add(r.secretName,i.key,r.optional);else add(r.secretName,null,r.optional);}for(const x of v.projected?.sources||[]){if(x.secret){const r=x.secret;if(r.items)for(const i of r.items)add(r.name,i.key,r.optional);else add(r.name,null,r.optional);}}}
 return refs.size?crypto.createHash('sha256').update(JSON.stringify([...refs].sort(([a],[b])=>a.localeCompare(b)))).digest('hex'):null;
}
// Strict RESP2 reader handles fragmented/nested responses. Server errors never
// enter logs: ACL responses include password hashes and AUTH carries secrets.
function parseResp(buffer,offset=0){
 const end=buffer.indexOf('\r\n',offset);if(end<0)return null;
 const kind=String.fromCharCode(buffer[offset]),line=buffer.subarray(offset+1,end).toString(),next=end+2;
 if(kind==='+')return {value:line,next};
 if(kind==='-')return {error:true,next};
 if(kind===':')return {value:Number(line),next};
 const n=Number(line);if(!Number.isInteger(n)||n<-1||n>1048576)blocked('REDIS_PROTOCOL');
 if(kind==='$'){if(n===-1)return {value:null,next};if(buffer.length<next+n+2)return null;if(buffer.subarray(next+n,next+n+2).toString()!=='\r\n')blocked('REDIS_PROTOCOL');return {value:buffer.subarray(next,next+n).toString(),next:next+n+2};}
 if(kind==='*'){if(n===-1)return {value:null,next};let p=next,items=[];for(let i=0;i<n;i++){const x=parseResp(buffer,p);if(!x)return null;if(x.error)return x;items.push(x.value);p=x.next;}return {value:items,next:p};}
 blocked('REDIS_PROTOCOL');
}
async function redisConnection({host,port=6379,secure=false},auth){
 const socket=secure?tls.connect({host,port,servername:host,minVersion:'TLSv1.2'}):net.connect({host,port});
 let buffer=Buffer.alloc(0),pending,dead=false;
 const end=()=>{dead=true;if(pending){clearTimeout(pending.timer);pending.reject(Object.assign(new Error('REDIS_CONNECTION'),{code:'REDIS_CONNECTION'}));pending=null;}};
 socket.on('error',end);socket.on('close',end);
 socket.on('data',data=>{buffer=Buffer.concat([buffer,data]);if(buffer.length>1048576){socket.destroy();return;}if(!pending)return;try{const x=parseResp(buffer);if(!x)return;buffer=buffer.subarray(x.next);const p=pending;pending=null;clearTimeout(p.timer);x.error?p.reject(Object.assign(new Error('REDIS_COMMAND'),{code:'REDIS_COMMAND'})):p.resolve(x.value);}catch{socket.destroy();}});
 const command=(...args)=>new Promise((resolve,reject)=>{if(dead||pending)return reject(Object.assign(new Error('REDIS_CONNECTION'),{code:'REDIS_CONNECTION'}));const timer=setTimeout(()=>socket.destroy(),10000);pending={resolve,reject,timer};socket.write(Buffer.concat([Buffer.from('*'+args.length+'\r\n'),...args.flatMap(x=>{const b=Buffer.from(String(x));return [Buffer.from('$'+b.length+'\r\n'),b,Buffer.from('\r\n')];})]));});
 try{await command('AUTH',...(auth.username?[auth.username]:[]),auth.password);return {command,close:()=>socket.destroy()};}catch(e){socket.destroy();throw e;}
}
function redisContract(d,claims,provider,secrets,adminSecret,externalSecrets=[]){
 const e=env(d.spec.template.spec.containers.find(c=>c.name===BRIDGE));
 const user=e.PREAUTHBRIDGE_REDIS_USERNAME?.valueFrom?.secretKeyRef,pw=e.PREAUTHBRIDGE_REDIS_PASSWORD?.valueFrom?.secretKeyRef;
 if(!user||!pw||user.name!==pw.name||user.key!=='username'||pw.key!=='password')blocked('BRIDGE_REDIS_CONTRACT');
 const claim=claims.find(c=>c.spec?.type==='redis'&&externalSecrets.some(es=>es.metadata.name===c.spec.externalSecretRef?.name&&(es.spec.target?.name||es.metadata.name)===user.name));
 if(!claim||claim.spec.providerRef?.name!==provider.metadata.name||(claim.status?.providerRef&&claim.status.providerRef!==provider.metadata.name))blocked('REDIS_CLAIM_PENDING');
 if(claim.spec.parameters?.acl?.keys?.length!==1||claim.spec.parameters.acl.keys[0]!=='auth:*'||claim.spec.parameters.acl.channels?.length||claim.spec.parameters.acl.commands?.length)blocked('REDIS_ACL_CONTRACT');
 const p=provider.spec.outputs?.env||{};
 if(p.REDIS_ISCLUSTER!=='false'||p.REDIS_TLS!=='false')blocked('REDIS_TOPOLOGY_CONTRACT');
 const endpoint=p.REDIS_HOSTS?.match(/^([a-zA-Z0-9.-]+):(\d+)$/);
 if(!endpoint||endpoint[1]!=='redis.infrastructure.svc.cluster.local'||endpoint[2]!=='6379')blocked('REDIS_ENDPOINT_CONTRACT');
 if(value(e,'PREAUTHBRIDGE_REDIS_HOSTS',secrets)!==p.REDIS_HOSTS)blocked('BRIDGE_REDIS_ENDPOINT');
 if(e.PREAUTHBRIDGE_REDIS_ISCLUSTER&&value(e,'PREAUTHBRIDGE_REDIS_ISCLUSTER',secrets)!=='false')blocked('BRIDGE_REDIS_TOPOLOGY');
 const username=decode(secrets.get(user.name),'username'),password=decode(secrets.get(user.name),'password');
 if(username==='default'||!username||/[\s\x00-\x1f]/.test(username))blocked('REDIS_ACCOUNT_CONTRACT');
 return {endpoint:{host:endpoint[1],port:6379},username,password,admin:{username:adminSecret.data?.username?decode(adminSecret,'username'):undefined,password:decode(adminSecret,'password')},database:claim.spec.parameters?.database||0};
}
async function ensureRedis(contract,{connect=redisConnection,repair=true}={}){
 const hash=crypto.createHash('sha256').update(contract.password).digest('hex');
 const admin=await connect(contract.endpoint,contract.admin);
 let changed=false;
 try{
  const result=await admin.command('ACL','GETUSER',contract.username);
  const acl=result?Object.fromEntries(Array.from({length:result.length/2},(_,i)=>[result[i*2],result[i*2+1]])):null;
  const matches=acl?.flags?.includes('on')&&!acl.flags.includes('nopass')&&acl.passwords?.length===1&&acl.passwords[0]===hash&&acl.keys==='~auth:*'&&acl.commands==='+@all'&&!(acl.selectors?.length);
  if(!matches){if(!repair)blocked('REDIS_ACCOUNT_UNREADY');await admin.command('ACL','SETUSER',contract.username,'reset','on','#'+hash,'~auth:*','+@all');changed=true;}
 }finally{admin.close();}
 const consumer=await connect(contract.endpoint,{username:contract.username,password:contract.password});
 try{if(await consumer.command('PING')!=='PONG')blocked('REDIS_AUTHENTICATION');if(contract.database)await consumer.command('SELECT',contract.database);}finally{consumer.close();}
 return {authenticated:true,changed};
}
function ownedPods(d,pods,replicasets){const ids=new Set(replicasets.filter(s=>s.metadata.ownerReferences?.some(o=>o.uid===d.metadata.uid&&o.controller===true)).map(s=>s.metadata.uid));return pods.filter(p=>!p.metadata.deletionTimestamp&&p.metadata.ownerReferences?.some(o=>ids.has(o.uid)&&o.controller===true)&&p.status?.phase==='Running'&&p.status.podIP);}
function verificationNatsContract(workload){
 const spec=workload?.spec?.template?.spec||workload?.spec;
 const containers=spec?.containers?.filter(c=>c.name===VERIFICATION)||[];
 if(containers.length!==1)return false;
 return Object.entries(VERIFICATION_NATS_ENV).every(([name,value])=>{
  const entries=containers[0].env?.filter(e=>e.name===name)||[];
  return entries.length===1&&entries[0].value===value&&!entries[0].valueFrom;
 });
}
function verificationNatsReady(d,pods,replicasets){
 if(!ready(d)||!verificationNatsContract(d))return false;
 const current=ownedPods(d,pods,replicasets);
 return current.length===(d.spec.replicas??1)&&current.every(p=>
  verificationNatsContract(p)&&p.metadata.annotations?.[ANNOTATION]===d.spec.template.metadata.annotations?.[ANNOTATION]&&
  p.spec.containers.find(c=>c.name===VERIFICATION)?.image===d.spec.template.spec.containers.find(c=>c.name===VERIFICATION)?.image);
}
function listeners(d,pods,replicasets,connections){
 const current=ownedPods(d,pods,replicasets).filter(p=>p.spec.containers.some(c=>c.name===d.metadata.name&&c.image===d.spec.template.spec.containers.find(c=>c.name===d.metadata.name)?.image)&&p.metadata.annotations?.[ANNOTATION]===d.spec.template.metadata.annotations?.[ANNOTATION]);
 const required=SUBJECTS[d.metadata.name]||[];
 return {name:d.metadata.name,deploymentUid:d.metadata.uid,generation:d.metadata.generation,podUids:current.map(p=>p.metadata.uid).sort(),ready:ready(d)&&current.length===(d.spec.replicas??1)&&current.every(p=>required.every(subject=>connections.some(c=>c.ip===p.status.podIP&&c.subscriptions_list?.includes(subject)))),subjects:required};
}
async function snapshot(api){
 const [deployments,secrets,claims,pods,replicasets,externalSecrets]=await Promise.all(['deployments','secrets','resourceclaims','pods','replicasets','externalsecrets'].map(x=>api.list(x,NS)));
 return {deployments,secrets:new Map(secrets.map(s=>[s.metadata.name,s])),claims,pods,replicasets,externalSecrets};
}
async function reconcile(api,{connect=redisConnection,now=Date.now}={}){
 const s=await snapshot(api),bridge=s.deployments.find(d=>d.metadata.name===BRIDGE),wk=s.deployments.find(d=>d.metadata.name===WELLKNOWN);
 if(!bridge||!wk)blocked('OCM_WORKLOADS_PENDING');
 const provider=await api.get('resourceproviders','redis'),ref=provider.spec.adminSecretRef;
 if(ref?.namespace!=='infrastructure'||ref.name!=='redis-root-auth')blocked('REDIS_ADMIN_CONTRACT');
 const admin=await api.get('secrets',ref.name,ref.namespace);
 const redis=await ensureRedis(redisContract(bridge,s.claims,provider,s.secrets,admin,s.externalSecrets),{connect});
 // ESO owns the canonical consumer Secrets. Never copy the Redis root login,
 // overwrite ESO targets, or put credentials into ApplicationSet values.
 let changed=false;
 for(const d of s.deployments){
  if(d.metadata.name==='esb-ocm-guard')continue;
  const hash=credentialDigest(d,s.secrets);
  // Let the first native Retrieval migration finish before establishing its
  // rollout checksum. Interrupting V001 can leave a dirty migration marker.
  if(d.metadata.name==='credential-retrieval-service'&&!ready(d)&&!d.spec.template.metadata.annotations?.[ANNOTATION])continue;
  if(hash&&d.spec.template.metadata.annotations?.[ANNOTATION]!==hash){await api.annotate(d,{[ANNOTATION]:hash});changed=true;}
 }
 const connections=await api.connections();
 const services=[bridge,wk].map(d=>listeners(d,s.pods,s.replicasets,connections));
 const missing=services.find(x=>x.name===WELLKNOWN&&!x.ready);
 // Restart an otherwise REST-ready Well-Known only after its exact configured
 // NATS credentials complete a real CONNECT/PING exchange. Cooldown survives
 // reconciler restarts through a deployment annotation.
 if(!changed&&missing&&ready(wk)){
  const previous=Date.parse(wk.spec.template.metadata.annotations?.[RECOVERY]||'');
  if(!Number.isFinite(previous)||now()-previous>=120000){
   await api.natsAvailable(wk,s.secrets);
   await api.annotate(wk,{[RECOVERY]:new Date(now()).toISOString()});changed=true;
  }
 }
 const consumers=s.deployments.filter(d=>d.metadata.name!=='esb-ocm-guard');
 const pending=consumers.filter(d=>!ready(d)).length;
 const latest=new Map((await api.list('secrets',NS)).map(x=>[x.metadata.name,x]));
 const stable=consumers.every(d=>credentialDigest(d,s.secrets)===credentialDigest(d,latest));
 const verificationReady=verificationNatsReady(s.deployments.find(d=>d.metadata.name===VERIFICATION),s.pods,s.replicasets);
 return {ready:!changed&&stable&&pending===0&&redis.authenticated&&services.every(x=>x.ready)&&verificationReady,...(!verificationReady?{code:'VERIFICATION_NATS_CONTRACT'}:{}),verificationNats:{ready:verificationReady},credentials:{synchronized:!changed&&stable&&pending===0,pendingRollouts:pending},redis:{authenticated:redis.authenticated},services,checkedAt:new Date(now()).toISOString()};
}
module.exports={NS,ANNOTATION,RECOVERY,BRIDGE,WELLKNOWN,VERIFICATION,VERIFICATION_NATS_ENV,SUBJECTS,ready,decode,env,value,credentialDigest,parseResp,redisConnection,redisContract,ensureRedis,ownedPods,verificationNatsContract,verificationNatsReady,listeners,snapshot,reconcile,blocked};
