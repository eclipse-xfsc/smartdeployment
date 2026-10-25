#!/usr/bin/env node
'use strict';
const {Runner}=require('../lib/runner');
const {health}=require('../lib/argo');
const controller=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>controller.abort());
const runner=new Runner({signal:controller.signal,emit:e=>process.stderr.write('[ESB_ARGO] '+JSON.stringify(e)+'\n')});
health(runner,{timeoutSeconds:Number(process.env.ESB_TIMEOUT_SECONDS||1800),diagnose:process.argv.includes('--diagnose')})
 .catch(e=>{process.stderr.write(`[${e.code||'ERROR'}] ${e.message}\n`);process.exitCode=1;});
