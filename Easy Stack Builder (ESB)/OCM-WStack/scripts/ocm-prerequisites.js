#!/usr/bin/env node
'use strict';
const {Runner}=require('../lib/runner');
const {prerequisites}=require('../lib/ocm');
const timeout=Number(process.env.ESB_TIMEOUT_SECONDS);
if(!Number.isInteger(timeout)||timeout<1)throw new Error('ESB_TIMEOUT_SECONDS is required.');
const controller=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>controller.abort());
const r=new Runner({signal:controller.signal,emit:e=>console.log('[ESB_API] '+JSON.stringify(e))});
// These commands belong to the outer bootstrap's process group, so cancelling
// that bootstrap also stops a Secret/ESO operation in this nested helper.
const run=r.run.bind(r);
r.run=(cmd,args,options={})=>run(cmd,args,{...options,processGroup:false});
prerequisites(r,timeout).catch(e=>{console.error(`[${e.code||'ERROR'}] ${e.message}`);process.exitCode=1;});
