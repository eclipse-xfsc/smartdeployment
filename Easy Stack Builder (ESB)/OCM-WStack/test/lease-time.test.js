'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');

test('Lease create, heartbeat and release all serialize Kubernetes MicroTime with six digits',async()=>{
  const filename=path.join(__dirname,'../lib/install.js');
  let heartbeat,cleared=false;
  const context={module:{exports:{}},require:createRequire(filename),
    setInterval(fn,ms){assert.equal(ms,45000);heartbeat=fn;return {unref(){}};},
    clearInterval(){cleared=true;},
    Date:class extends Date{constructor(){super('2026-10-01T00:38:26.354Z');}static now(){return Date.parse('2026-10-01T00:38:26.354Z');}}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});
  const writes=[];
  function accept(options){
    const doc=JSON.parse(options.input);
    // Match the MicroTime wire contract, including the user's failing timestamp.
    for(const name of ['acquireTime','renewTime'])assert.equal(doc.spec[name],'2026-10-01T00:38:26.354000Z');
    writes.push(JSON.parse(options.input));return doc;
  }
  const runner={async json(command,args,options){return args.includes('get')?null:accept(options);},async run(command,args,options){accept(options);return {code:0};}};
  const held=await context.module.exports.lease(runner,'test-holder');
  heartbeat();await held.release();held.check();
  assert.equal(writes.length,3);assert.equal(writes[0].spec.holderIdentity,'test-holder');assert.equal(writes[1].spec.holderIdentity,'test-holder');assert.equal(writes[2].spec.holderIdentity,'');assert.equal(cleared,true);
  assert.equal(Date.parse(writes[0].spec.acquireTime),Date.parse('2026-10-01T00:38:26.354Z'));
});

for(const scenario of ['lost-response','changed-owner','persistent-outage'])test(`Lease renewal handles ${scenario} without writing with stale ownership`,async()=>{
  const filename=path.join(__dirname,'../lib/install.js'),localRequire=createRequire(filename);
  let heartbeat,server=null,lost=false,renewals=0,reads=0;const writes=[];
  const context={module:{exports:{}},require:name=>name==='./api-recovery'?{...localRequire(name),delay:async()=>{}}:localRequire(name),setInterval(fn){heartbeat=fn;return {unref(){}};},clearInterval(){},Date};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});
  const clone=doc=>JSON.parse(JSON.stringify(doc));
  const eof=()=>Object.assign(new Error('Put "https://api.test/apis/coordination.k8s.io/v1/leases/esb": EOF'),{code:'COMMAND_FAILED'});
  const runner={
    async json(command,args,options){
      if(args.includes('get')){reads++;return clone(server);}
      const submitted=JSON.parse(options.input);writes.push(clone(submitted));
      if(args.includes('create')){server={...submitted,metadata:{...submitted.metadata,resourceVersion:'1'}};return clone(server);}
      renewals++;assert.equal(submitted.metadata.resourceVersion,server.metadata.resourceVersion);
      server={...submitted,metadata:{...submitted.metadata,resourceVersion:String(Number(server.metadata.resourceVersion)+1)}};
      if(scenario==='changed-owner')server.spec.holderIdentity='new-owner';
      if(renewals===1||scenario==='persistent-outage')throw eof();
      return clone(server);
    },
    async run(command,args,options){writes.push(JSON.parse(options.input));return {code:0};}
  };
  const held=await context.module.exports.lease(runner,'test-holder',()=>{lost=true;});heartbeat();await held.release();
  if(scenario==='lost-response'){
    held.check();assert.equal(lost,false);assert.equal(renewals,2);assert.equal(reads,2);
    assert.equal(writes[2].metadata.resourceVersion,'2');assert.equal(writes.at(-1).spec.holderIdentity,'');
  } else {
    assert.throws(()=>held.check(),{code:'LEASE_LOST'});assert.equal(lost,true);
    assert.equal(renewals,scenario==='changed-owner'?1:3);
    assert.ok(writes.every(d=>d.spec.holderIdentity==='test-holder'),'must not release or overwrite another owner after uncertainty');
  }
});
