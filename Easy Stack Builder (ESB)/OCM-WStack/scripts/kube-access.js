#!/usr/bin/env node
'use strict';
const {Runner}=require('../lib/runner');
const {argo}=require('../lib/kube-access');
const controller=new AbortController();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>controller.abort());
const runner=new Runner({signal:controller.signal,emit:event=>process.stderr.write('[ESB_API] '+JSON.stringify(event)+'\n')});
argo(runner).catch(e=>{process.stderr.write(`[${e.code||'ERROR'}] ${e.message}\n`);process.exitCode=1;});
