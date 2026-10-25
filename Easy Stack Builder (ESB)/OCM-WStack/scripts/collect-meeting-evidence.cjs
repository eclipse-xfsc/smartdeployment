#!/usr/bin/env node
'use strict';
// Read-only collection. Never copies Secrets, full pod specs, logs or credentials.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const ns=process.argv[2]||'ocm-wstack';if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ns))throw Error('Invalid namespace');
const out=path.resolve(process.argv[3]||'ocm-evidence-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(out,{recursive:true,mode:0o700});
const errors=[];
function json(args){const r=spawnSync('kubectl',['-n',ns,...args,'-o','json'],{encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});if(r.status!==0){errors.push({check:args.join(' '),exit:r.status});return {items:[]};}try{return JSON.parse(r.stdout);}catch{errors.push({check:args.join(' '),code:'INVALID_RESPONSE'});return {items:[]};}}
const pods=json(['get','pods']).items.map(p=>({name:p.metadata.name,phase:p.status?.phase,containers:(p.status?.containerStatuses||[]).map(c=>({name:c.name,image:c.image,imageID:c.imageID,ready:c.ready,restarts:c.restartCount,waitingReason:c.state?.waiting?.reason||null}))}));
const deployments=json(['get','deployments']).items.map(d=>({name:d.metadata.name,desired:d.spec.replicas,ready:d.status?.readyReplicas||0,images:d.spec.template.spec.containers.map(c=>({name:c.name,image:c.image}))}));
const source=fs.readFileSync(path.join(__dirname,'diagnose-runtime-inpod.cjs'),'utf8');
const r=spawnSync('kubectl',['-n',ns,'exec','-i','deployment/ocm-orce','-c','orce','--','env','OCM_DIAGNOSTICS_EVIDENCE=1','node','-'],{input:source,encoding:'utf8',timeout:120000,maxBuffer:1048576});
let diagnostics;try{diagnostics=JSON.parse(r.stdout);}catch{diagnostics={status:'not-collected',exit:r.status};errors.push({check:'native API diagnostics',exit:r.status});}
const report={collectedAt:new Date().toISOString(),namespace:ns,packageVersion:require('../package.json').version,source:require('../docs/source-provenance.json'),pods,deployments,diagnostics,errors,limits:['Pod readiness does not prove native API functionality.','Offer acceptance does not prove credential persistence.','No credentials, offers, tokens, raw logs or Secret objects are collected.']};
fs.writeFileSync(path.join(out,'meeting-evidence.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
fs.copyFileSync(path.join(__dirname,'../docs/MEETING-BRIEF.md'),path.join(out,'MEETING-BRIEF.md'));
console.log('Evidence written to '+out);console.log('Native checks: '+diagnostics.status);process.exitCode=errors.length?1:diagnostics.status==='ready'?0:2;
