'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {tunnel}=require('../lib/tunnel');
test('localhost tunnel cleanup completes after cancellation has already killed the process',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-tunnel-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'kubectl'),'#!/usr/bin/env node\nconsole.log("Forwarding from 127.0.0.1:18080 -> 8080");setInterval(()=>{},100);\n',{mode:0o700});
  const controller=new AbortController();
  const forwarded=await tunnel('credential-retrieval-service',{...process.env,PATH:`${dir}:${process.env.PATH}`},controller.signal);
  assert.equal(forwarded.url,'http://127.0.0.1:18080');controller.abort();
  await new Promise(resolve=>setTimeout(resolve,100));
  await Promise.race([forwarded.close(),new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Tunnel cleanup hung')),2000);timer.unref();})]);
  await forwarded.close();
});
