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

test('cancelling an outer bootstrap also terminates a nested helper and its child',async t=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-process-group-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const pidfile=path.join(dir,'child.pid'),helper=path.join(dir,'helper.cjs');
  // /proc may expose host PIDs while process.pid is namespaced in CI. Monitor
  // the child's actual /proc entry instead of an unrelated host process.
  await fs.writeFile(helper,`const {Runner}=require(${JSON.stringify(require.resolve('../lib/runner'))});new Runner().run(process.execPath,['-e',${JSON.stringify("const fs=require('node:fs');fs.writeFileSync(process.argv[1],fs.readlinkSync('/proc/self'));setInterval(()=>{},1000)")},process.argv[2]],{processGroup:false}).catch(()=>{});`);
  const controller=new AbortController();
  const done=new Runner({signal:controller.signal}).run(process.execPath,[helper,pidfile],{timeout:10000});
  const rejected=assert.rejects(done,{code:'CANCELLED'});
  let pid;
  for(let attempt=0;attempt<100;attempt++){
    try {pid=Number(await fs.readFile(pidfile,'utf8'));break;}catch {await new Promise(resolve=>setTimeout(resolve,20));}
  }
  controller.abort();await rejected;assert.ok(pid,'nested child started');
  let running=true;
  for(let attempt=0;attempt<100;attempt++){
    try {const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');running=!/^\d+ \(.*\) Z /.test(stat);}catch(e){if(['ENOENT','ESRCH'].includes(e.code))running=false;else throw e;}
    if(!running)break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(running,false,'nested command must not survive bootstrap cancellation');
});

test('cancelling the actual OCM prerequisites helper also stops its active kubectl',async t=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-ocm-cancel-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const pidfile=path.join(dir,'pid');
  await fs.writeFile(path.join(dir,'kubectl'),`#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(process.env.ESB_TEST_PID,fs.readlinkSync('/proc/self'));setInterval(()=>{},1000);\n`,{mode:0o700});
  const controller=new AbortController();
  const r=new Runner({signal:controller.signal,env:{...process.env,PATH:dir+':'+process.env.PATH,ESB_TIMEOUT_SECONDS:'60',ESB_TEST_PID:pidfile}});
  const done=r.run(process.execPath,[path.join(__dirname,'../scripts/ocm-prerequisites.js')]);
  const rejected=assert.rejects(done,{code:'CANCELLED'});
  let pid;
  for(let i=0;i<100;i++){try{pid=Number(await fs.readFile(pidfile,'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,20));}}
  controller.abort();await rejected;assert.ok(pid);
  let running=true;
  for(let i=0;i<100;i++){
    try{running=!/^\d+ \(.*\) Z /.test(await fs.readFile(`/proc/${pid}/stat`,'utf8'));}catch(e){if(['ENOENT','ESRCH'].includes(e.code))running=false;else throw e;}
    if(!running)break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(running,false,'prerequisite kubectl must stop with the bootstrap');
});
