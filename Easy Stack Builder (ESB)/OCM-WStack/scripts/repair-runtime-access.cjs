'use strict';
const {spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const ns=process.argv[2]||'ocm-wstack';
if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ns))throw Error('Invalid namespace');
function run(args,input){const r=spawnSync('kubectl',['-n',ns,...args],{input,encoding:'utf8',maxBuffer:1024*1024});if(r.status!==0)throw Error('kubectl failed: '+r.stderr);return r.stdout;}
try{
 const secret=JSON.parse(run(['get','secret','keycloak-init-secrets','-o','json']));
 if(!secret.data?.password)throw Error('Keycloak bootstrap password is missing');
 const code=fs.readFileSync(path.join(__dirname,'repair-iam-inpod.cjs'),'utf8');
 console.log(run(['exec','-i','deployment/ocm-orce','-c','orce','--','node','-e',code],JSON.stringify({adminPassword:Buffer.from(secret.data.password,'base64').toString()})).trim());
}catch(e){console.error(e.message);process.exitCode=1;}
