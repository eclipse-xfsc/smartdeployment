'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
async function run({accept=true,importFailure=false}={}){
 const calls=[],output=[],process={env:{OCM_SMOKE_ACCEPT:accept?'1':'0'},exitCode:0};
 const cfg={tenant:'t',account:'a',group:'g',services:{}};
 const api={load:()=>cfg,Client:class{},Adapters:class{
  async importOffer(c,offer){calls.push('import');assert.equal(offer,'secret-offer');if(importFailure)throw {code:'IMPORT_FAILED',upstreamStatus:400};return {upstreamRequestId:'req-1'};}
  async offers(){calls.push('list');return {items:[{requestId:'req-1'}]};}
  async accept(c,id,yes){assert.equal(id,'req-1');assert.equal(yes,true);calls.push('accept');}
  async list(){calls.push('storage');throw {code:'UPSTREAM_REJECTED',upstreamStatus:400,reason:'STORAGE_REGION_MISSING'};}
 },Events:class{async start(){this.connected=true;}async issue(){calls.push('issue');return {offer:{secret:'must-not-be-printed'}};}async close(){}},IssuerBootstrap:class{async ensure(){}close(){}},offerUrl:()=> 'secret-offer',randomUUID:()=> 'issue-1'};
 const sandbox={require:name=>name==='/data/package.json'?{version:'11.1.0'}:api,process,console:{log:x=>output.push(x),error:x=>output.push(x)},setTimeout};
 await vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../scripts/retrieval-smoke-inpod.cjs'),'utf8'),sandbox);
 return {calls,report:JSON.parse(output[0]),exit:process.exitCode,output:output.join('')};
}
test('demo smoke distinguishes accepted Retrieval from blocked Storage without exposing offer',async()=>{const r=await run();assert.deepEqual(r.calls,['issue','import','list','accept','storage']);assert.equal(r.exit,2);assert.equal(r.report.status,'retrieval-passed-storage-blocked');assert.doesNotMatch(r.output,/secret-offer|must-not-be-printed/);});
test('demo smoke stops before acceptance when offer import fails',async()=>{const r=await run({importFailure:true});assert.deepEqual(r.calls,['issue','import']);assert.equal(r.exit,1);assert.equal(r.report.status,'failed');});
test('demo smoke only accepts when explicitly selected',async()=>{const r=await run({accept:false});assert.ok(!r.calls.includes('accept'));assert.equal(r.report.mode,'issue-import');});
