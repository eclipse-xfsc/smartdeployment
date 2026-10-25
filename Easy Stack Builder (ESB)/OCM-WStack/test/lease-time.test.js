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
