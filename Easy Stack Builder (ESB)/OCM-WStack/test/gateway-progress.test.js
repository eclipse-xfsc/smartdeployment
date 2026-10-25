'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Runner}=require('../lib/runner');
test('bootstrap routing progress survives its subprocess and is redacted before emission',async()=>{
 const events=[],r=new Runner({emit:e=>events.push(e),secrets:['private-value']});
 const source=`console.log('[ESB_API] '+JSON.stringify({type:'routing-progress',elapsedSeconds:12,message:'private-value'}));console.log('[ESB_API] malformed');console.log('[ESB_PHASE] tenant');`;
 await r.run(process.execPath,['-e',source],{live:true});
 assert.deepEqual(events[0],{type:'routing-progress',elapsedSeconds:12,message:'[redacted]'});
 assert.equal(events[1].type,'log');assert.equal(events[2].phase,'tenant');
});
