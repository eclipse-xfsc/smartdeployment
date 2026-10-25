#!/usr/bin/env node
'use strict';
const {parseArgs}=require('node:util');
const {Runner}=require('../lib/runner');
const {diagnose}=require('../lib/storage-diagnostics');
async function main(){
 const {values}=parseArgs({options:{kubeconfig:{type:'string'}}});
 const env={...process.env,...(values.kubeconfig?{KUBECONFIG:values.kubeconfig}:{})};
 console.log(JSON.stringify(await diagnose(new Runner({env})),null,2));
}
main().catch(e=>{console.error(e.code||'DIAGNOSTIC_FAILED');process.exitCode=1;});
