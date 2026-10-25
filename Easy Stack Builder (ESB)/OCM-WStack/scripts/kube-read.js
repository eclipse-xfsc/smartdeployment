#!/usr/bin/env node
'use strict';
const {Runner}=require('../lib/runner');
const {read}=require('../lib/kube-read');
const controller=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>controller.abort());
const [endpoint,condition]=process.argv.slice(2);
const runner=new Runner({signal:controller.signal,emit:event=>{
  if(event.type==='log')process.stderr.write(event.message+'\n');
  else process.stderr.write('[ESB_API] '+JSON.stringify(event)+'\n');
}});
read(runner,endpoint,{established:condition==='established',timeoutSeconds:Number(process.env.ESB_READ_TIMEOUT_SECONDS||120)})
  .then(doc=>process.stdout.write(JSON.stringify(doc)+'\n'))
  .catch(e=>{process.stderr.write(`[${e.code||'ERROR'}] ${e.message}\n`);process.exitCode=1;});
