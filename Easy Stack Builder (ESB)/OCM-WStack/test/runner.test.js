'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Runner}=require('../lib/runner');
test('process timeout stops a command and preserves redaction',async()=>{
  const events=[];const r=new Runner({emit:e=>events.push(e),secrets:['very-private-token']});
  await assert.rejects(r.run(process.execPath,['-e','console.error("very-private-token");setInterval(()=>{},100)'],{timeout:150,live:true}),{code:'TIMEOUT'});
  assert.ok(!JSON.stringify(events).includes('very-private-token'));
});
test('arguments are passed literally rather than interpreted by a shell',async()=>{
  const r=new Runner();const value='$(echo bad); `touch bad`';
  const result=await r.run(process.execPath,['-e','process.stdout.write(process.argv[1])',value]);assert.equal(result.stdout,value);
});
