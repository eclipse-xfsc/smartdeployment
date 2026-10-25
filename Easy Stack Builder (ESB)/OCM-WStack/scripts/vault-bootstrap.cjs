'use strict';
const {spawnSync}=require('node:child_process');

// Crypto plugin mount = namespace when group is empty; otherwise namespace/group.
// Use the shared root crypto mount; parent and child mounts cannot coexist.
function plan(namespace){
 if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace))throw Error('Invalid Kubernetes namespace');
 const mounts=new Map();
 for(const [mount,keys] of [
  [namespace,['signerkey','DeveloperCredential','SDJWTCredential','eckey','storagekey']],
  ['tenant_space',['DeveloperCredential','SDJWTCredential','signerkey']],
  ['transit',['DeveloperCredential','SDJWTCredential']]
 ])mounts.set(mount,[...new Set([...(mounts.get(mount)||[]),...keys])]);
 return mounts;
}
function parseJSON(result,label){try{return JSON.parse(result.stdout);}catch{throw Error('Invalid Vault JSON for '+label);}}
function checked(result,label){if(result.status!==0)throw Error(label+' failed (exit '+result.status+'): '+String(result.stderr||'').trim().slice(0,1200));return result;}
async function bootstrap(namespace,run,log=()=>{}){
 const desired=plan(namespace),mounts=parseJSON(checked(await run(['secrets','list','-format=json']),'Vault mount inspection'),'mounts');
 // Inspect every desired mount before making any changes. Never disable or remount.
 for(const mount of desired.keys()){
  const path=mount+'/';
  for(const [existing,engine] of Object.entries(mounts)){
   if(existing===path){if(engine.type!=='transit')throw Error('Vault mount '+path+' exists with type '+engine.type+'; refusing to replace it.');}
   else if(existing.startsWith(path)||path.startsWith(existing))throw Error('Vault mount '+path+' conflicts with existing '+existing+'; keys retained.');
  }
 }
 for(const [mount,keys] of desired){
  if(!mounts[mount+'/']){
   checked(await run(['secrets','enable','-path='+mount,'transit']),'Enable Vault mount '+mount+'/');
   mounts[mount+'/']={type:'transit'};log('Created transit mount '+mount+'/');
  }else log('Reusing transit mount '+mount+'/');
  for(const key of keys){
   const path=mount+'/keys/'+key;
   let result=await run(['read','-format=json',path]);
   if(result.status!==0){
    // Vault read uses exit 2 with this exact message only for an absent value.
    // Permission, transport, sealed-Vault and other errors must not create keys.
    if(result.status!==2||String(result.stderr||'').replace(/\r/g,'').split('\n').filter(line=>line!=='command terminated with exit code 2').join('\n').trim()!=='No value found at '+path)checked(result,'Inspect Vault key '+path);
    checked(await run(['write','-format=json',path,'type=ecdsa-p256']),'Create Vault key '+path);
    result=checked(await run(['read','-format=json',path]),'Verify Vault key '+path);
   }
   const metadata=parseJSON(result,path);
   if(metadata.data?.type!=='ecdsa-p256')throw Error('Vault key '+path+' has incompatible type; existing key retained.');
  }
 }
 const policy=['DeveloperCredential','SDJWTCredential'].flatMap(key=>[
  'path "transit/sign/'+key+'" { capabilities = ["update"] }',
  'path "transit/verify/'+key+'" { capabilities = ["update"] }',
  'path "transit/keys/'+key+'" { capabilities = ["read","list"] }'
 ]).join('\n')+'\n';
 checked(await run(['policy','write','crypto-engine-policy','-'],policy),'Write crypto engine policy');
}
function runner(namespace,token,spawn=spawnSync){
 return (args,input='')=>{
  // Token is delivered through stdin, never shell interpolation or argv.
  const result=spawn('kubectl',['-n',namespace,'exec','-i','vault-0','--','sh','-c','IFS= read -r VAULT_TOKEN; export VAULT_TOKEN; export VAULT_ADDR=http://127.0.0.1:8200; exec vault "$@"','sh',...args],{input:token+'\n'+input,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  return {...result,stderr:String(result.stderr||result.error?.message||'').split(token).join('[REDACTED]')};
 };
}
if(require.main===module){
 const ns=process.argv[2],token=process.env.OCM_VAULT_TOKEN;
 if(!token||/[\r\n]/.test(token)){console.error('Vault bootstrap: missing or invalid token');process.exit(1);}
 bootstrap(ns,runner(ns,token),message=>console.log(message)).catch(e=>{console.error('Vault bootstrap: '+e.message);process.exitCode=1;});
}
module.exports={plan,bootstrap,runner};
