'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {probe,diagnose}=require('../lib/storage-diagnostics'),{Runner}=require('../lib/runner');
test('storage diagnostic exercises only health, Swagger and filter reads and never emits credentials',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-diagnostic-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const seen=[];const server=http.createServer((req,res)=>{seen.push([req.method,req.url]);res.setHeader('content-type','application/json');
  if(req.url==='/swagger/doc.json')res.end(JSON.stringify({basePath:'/v1/tenants/{tenantId}/storage/{region}/{country}/{account}',paths:{'/credentials':{},'/presentations':{}},secret:'must-not-leak'}));
  else if(req.method==='POST'){res.statusCode=400;res.end(JSON.stringify({message:'Region Id Missing.',credentials:{private:'must-not-leak'}}));}
  else res.end(JSON.stringify({status:true}));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const file=path.join(dir,'config.json');await fs.writeFile(file,JSON.stringify({services:{storage:`http://127.0.0.1:${server.address().port}`},tenant:'tenant',account:'account',group:'group'}));
 const runner=new Runner({env:{...process.env,OCM_RUNTIME_CONFIG:file}});
 const result=await runner.run(process.execPath,['-'],{input:probe});
 assert.equal(result.stdout.includes('must-not-leak'),false);
 const data=JSON.parse(result.stdout);assert.equal(data.checks[2].nativeMessage,'Region Id Missing.');
 assert.equal(data.checks[1].storagePaths.length,2);
 assert.deepEqual(seen.sort(),[['GET','/swagger/doc.json'],['GET','/v1/metrics/health'],['POST','/v1/tenants/tenant/storage/EU/DE/account/credentials']].sort());
 const report=await diagnose({json:async()=>({items:[{metadata:{name:'storage-service-example'},status:{containerStatuses:[{name:'storage-service',image:'native:1.2.4',imageID:'native@sha256:example',ready:true}]}}]}),run:async(cmd,args,options)=>{assert.equal(cmd,'kubectl');assert.ok(args.includes('exec'));assert.equal(options.input,probe);return result;}});
 assert.equal(report.images[0].containers[0].imageID,'native@sha256:example');
});
