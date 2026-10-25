#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');
const {parseArgs}=require('node:util');
const {Runner}=require('../lib/runner');
const {operation}=require('../lib/install');

async function main() {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{config:{type:'string'},kubeconfig:{type:'string'},'dns-token-file':{type:'string'},'dns-secret-file':{type:'string'},confirm:{type:'string'},help:{type:'boolean',short:'h'}}});
  if(values.help||!positionals.length){console.log('Usage: node scripts/cli.js <check|deploy|inspect|validate|test-credentials|teardown> --config deployment.json --kubeconfig cluster.yaml [--dns-token-file token.txt] [--dns-secret-file secrets.json] [--confirm "..."]');return;}
  const action=positionals[0];
  if(positionals.length!==1)throw new Error('Provide exactly one action.');
  if(action==='check') {
    const runner=new Runner();
    const results=await Promise.all(['bash','git','helm','kubectl','jq','curl','base64'].map(async name=>({name,available:(await runner.run('bash',['-c','command -v "$1" >/dev/null','esb-prerequisite',name],{allowFailure:true})).code===0})));
    console.log(JSON.stringify({node:process.version,tools:results},null,2));
    if(results.some(x=>!x.available))process.exitCode=1;
    return;
  }
  if(!values.config||!values.kubeconfig)throw new Error('--config and --kubeconfig are required.');
  const input=JSON.parse(await fs.readFile(values.config,'utf8'));
  const credentials={kubeconfig:await fs.readFile(values.kubeconfig,'utf8'),dnsToken:values['dns-token-file']?(await fs.readFile(values['dns-token-file'],'utf8')).trim():undefined,dnsSecretData:values['dns-secret-file']?await fs.readFile(values['dns-secret-file'],'utf8'):undefined};
  const controller=new AbortController();
  for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>controller.abort());
  const result=await operation(action,{...input,confirm:values.confirm},credentials,{signal:controller.signal,emit:event=>process.stderr.write(JSON.stringify({timestamp:new Date().toISOString(),...event})+'\n')});
  console.log(JSON.stringify(result,null,2));
  if(result.status==='failed'||result.status==='action-required')process.exitCode=2;
}
main().catch(e=>{console.error(JSON.stringify({status:'failed',code:e.code||'ERROR',message:e.message}));process.exitCode=1;});
