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
  await fs.writeFile(helper,`const {Runner}=require(${JSON.stringify(require.resolve('../lib/runner'))});new Runner().run(process.execPath,['-e',${JSON.stringify("require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)")},process.argv[2]],{processGroup:false}).catch(()=>{});`);
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
    try {const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');running=!/^\d+ \(.*\) Z /.test(stat);}catch(e){if(e.code==='ENOENT')running=false;else throw e;}
    if(!running)break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(running,false,'nested command must not survive bootstrap cancellation');
});
