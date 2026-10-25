#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const ns=process.argv[2]||'ocm-wstack';if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ns))throw Error('Invalid namespace');
const accept=process.argv.includes('--accept');console.error('Creates one DEMO issuance and imports its offer'+(accept?', then accepts it.':'. The offer remains pending.'));
const r=spawnSync('kubectl',['-n',ns,'exec','-i','deployment/ocm-orce','-c','orce','--','env','OCM_SMOKE_ACCEPT='+Number(accept),'node','-'],{input:fs.readFileSync(path.join(__dirname,'retrieval-smoke-inpod.cjs'),'utf8'),encoding:'utf8',timeout:150000,maxBuffer:1048576});
process.stdout.write(r.stdout||'');if(r.status===null)console.error('Runner interrupted; check the UI before retrying because the outcome is unknown.');process.exitCode=r.status??1;
