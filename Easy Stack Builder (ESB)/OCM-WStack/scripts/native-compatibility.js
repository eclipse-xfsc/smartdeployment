#!/usr/bin/env node
'use strict';
const {Runner}=require('../lib/runner');
const controller=new AbortController();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>controller.abort());
const r=new Runner({signal:controller.signal,emit:e=>console.log('[ESB_API] '+JSON.stringify(e))});
const run=r.run.bind(r);r.run=(cmd,args,o={})=>run(cmd,args,{...o,processGroup:false});
const timeout=Number(process.env.ESB_TIMEOUT_SECONDS);
if(!Number.isInteger(timeout)||timeout<1)throw Error('ESB_TIMEOUT_SECONDS is required.');
require('../lib/native-compatibility').cassandra(r,timeout).catch(e=>{console.error(`[${e.code||'ERROR'}] ${e.message}`);process.exitCode=1;});
