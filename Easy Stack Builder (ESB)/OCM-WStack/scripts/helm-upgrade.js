#!/usr/bin/env node
'use strict';
const {Runner}=require('../lib/runner');
const {upgrade}=require('../lib/api-recovery');
const controller=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>controller.abort());
const [namespace,release,...args]=process.argv.slice(2);
const runner=new Runner({signal:controller.signal,emit:event=>{
  if(event.type==='log')process.stderr.write(event.message+'\n');
  else process.stderr.write('[ESB_API] '+JSON.stringify(event)+'\n');
}});
if(!/^[a-z0-9-]+$/.test(namespace||'')||!/^[a-z0-9-]+$/.test(release||'')) {
  process.stderr.write('Helm recovery requires a namespace and release.\n');process.exitCode=1;
} else {
  upgrade(runner,args,{namespace,release,processGroup:false,timeout:(Number(process.env.ESB_TIMEOUT_SECONDS||1800)+30)*1000})
    .catch(e=>{process.stderr.write(`[${e.code||'ERROR'}] ${e.message}\n`);process.exitCode=1;});
}
