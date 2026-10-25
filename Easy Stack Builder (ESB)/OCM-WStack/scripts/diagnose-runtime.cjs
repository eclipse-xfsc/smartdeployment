'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const ns=process.argv[2]||'ocm-wstack',strict=process.argv.includes('--strict');
if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ns))throw Error('Invalid namespace');
const source=fs.readFileSync(path.join(__dirname,'diagnose-runtime-inpod.cjs'),'utf8');
const r=spawnSync('kubectl',['-n',ns,'exec','-i','deployment/ocm-orce','-c','orce','--','env','OCM_DIAGNOSTICS_STRICT='+Number(strict),'node','-'],{input:source,encoding:'utf8'});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status??1;
