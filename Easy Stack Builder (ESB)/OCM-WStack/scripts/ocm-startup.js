#!/usr/bin/env node
'use strict';
const {Runner}=require('../lib/runner');
const {stabilize}=require('../lib/ocm-startup');
const controller=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>controller.abort());
const timeoutSeconds=Number(process.env.ESB_TIMEOUT_SECONDS);
if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<1)throw new Error('ESB_TIMEOUT_SECONDS is required.');
const r=new Runner({signal:controller.signal,emit:e=>console.log('[ESB_API] '+JSON.stringify(e))});
const run=r.run.bind(r);r.run=(cmd,args,options={})=>run(cmd,args,{...options,processGroup:false});
stabilize(r,{timeoutSeconds,runtimeEnabled:process.env.ESB_NATIVE_DIDCOMM==='true'})
 .catch(e=>{console.error(`[${e.code||'ERROR'}] ${e.message}`);process.exitCode=1;});
