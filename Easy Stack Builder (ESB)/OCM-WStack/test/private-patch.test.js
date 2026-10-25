'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {Runner}=require('../lib/runner'),{privatePatch}=require('../lib/private-patch');

for(const fails of [false,true])test(`private patch opens a real file through the spawned runner and cleans up on ${fails?'failure':'success'}`,async()=>{
 let file;const payload={stringData:{password:'test-only-private-payload'}};
 const runner=new Runner();
 const r={run:async(command,args,options)=>{
  assert.equal(command,'kubectl');assert.equal(options,undefined);
  assert.equal(args.includes(JSON.stringify(payload)),false);
  file=args[args.indexOf('--patch-file')+1];
  assert.equal((await fs.stat(file)).mode&0o777,0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);
  // Exercise pathname reopening from a real child, the behavior the old mocks missed.
  const result=await runner.run(process.execPath,['-e',
   `const fs=require('node:fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); if(data.stringData.password!=='test-only-private-payload')process.exit(2); ${fails?'process.exit(3)':'process.stdout.write("read")'}`,file]);
  return result;
 }};
 if(fails)await assert.rejects(privatePatch(r,['patch','secret','example','--type=merge'],payload),{code:'COMMAND_FAILED'});
 else assert.equal((await privatePatch(r,['patch','secret','example','--type=merge'],payload)).stdout,'read');
 await assert.rejects(fs.stat(file),{code:'ENOENT'});
 await assert.rejects(fs.stat(path.dirname(file)),{code:'ENOENT'});
});
