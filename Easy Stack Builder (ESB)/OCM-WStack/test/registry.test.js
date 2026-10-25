'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Runner}=require('../lib/runner');
const {verifyImage,challenge,imageManifest}=require('../lib/registry');
const {imagePreflight}=require('../lib/ocm');
const REGISTRY='node-654e3bca7fbeeed18f81d7c7.ps-xaas.io';
const TOKEN='private.registry-token-for-test';
const CHALLENGE=`Bearer realm="https://${REGISTRY}/service/token",service="harbor-registry",scope="repository:tsa/policy:pull,push"`;
const MANIFEST={schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{mediaType:'application/vnd.oci.image.config.v1+json'},layers:[]};

async function setup(t,handler) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-registry-test-'));
  const requests=[],calls=[],events=[];
  const server=http.createServer((req,res)=>{requests.push({method:req.method,url:req.url,authorization:req.headers.authorization});handler(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  const r=new Runner({cwd:dir,emit:e=>events.push(e)}),run=r.run.bind(r);
  r.run=async(cmd,args,opts)=>{
    calls.push([...args]);
    for(const flag of ['--output','--dump-header']) {
      const file=args[args.indexOf(flag)+1];
      assert.equal((await fs.stat(file)).mode&0o777,0o600);
      assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);
    }
    if(args.some(a=>a.startsWith('@')))assert.equal((await fs.stat(args.find(a=>a.startsWith('@')).slice(1))).mode&0o777,0o600);
    // Use real curl/HTTP responses while mapping production HTTPS URLs only in
    // the test transport. Production still rejects insecure token realms.
    const url=new URL(args.at(-1));assert.equal(url.protocol,'https:');
    return await run(cmd,[...args.slice(0,-1),'--noproxy','127.0.0.1',`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`],opts);
  };
  return {dir,r,requests,calls,events};
}
function response(res,status,body,challengeValue) {
  res.writeHead(status,{'Content-Type':'application/json',...(challengeValue?{'WWW-Authenticate':challengeValue}:{})});
  res.end(body===undefined?'':typeof body==='string'?body:JSON.stringify(body));
}
for(const tokenField of ['token','access_token'])test(`real curl negotiates anonymous ${tokenField} and checks authenticated HEAD and GET without exposing tokens`,async t=>{
  const h=await setup(t,(req,res)=>{
    if(req.url.startsWith('/service/token'))return response(res,200,{[tokenField]:TOKEN});
    if(req.headers.authorization!==`Bearer ${TOKEN}`)return response(res,401,{},CHALLENGE);
    response(res,200,req.method==='HEAD'?undefined:MANIFEST);
  });
  await imagePreflight(h.r,h.dir);
  assert.deepEqual(h.requests.map(x=>x.method),['HEAD','GET','HEAD','GET']);
  const tokenURL=new URL(h.requests[1].url,'https://test');
  assert.equal(tokenURL.searchParams.get('service'),'harbor-registry');
  assert.equal(tokenURL.searchParams.get('scope'),'repository:tsa/policy:pull');
  assert.equal(h.requests[1].authorization,undefined);
  assert.equal(h.requests[2].authorization,`Bearer ${TOKEN}`);
  assert.equal(h.requests[3].authorization,`Bearer ${TOKEN}`);
  assert.equal(h.events.at(-1).authentication,'anonymous-bearer');
  assert.ok(!JSON.stringify(h.calls).includes(TOKEN));assert.ok(!JSON.stringify(h.events).includes(TOKEN));
  assert.equal(h.r.redact(`Authorization: Bearer ${TOKEN}`),'Authorization: Bearer [redacted]');
  assert.deepEqual(await fs.readdir(h.dir),[],'transient token/manifest files must be deleted');
});
test('GET challenge is negotiated even when anonymous HEAD succeeds',async t=>{
  const h=await setup(t,(req,res)=>req.url.startsWith('/service/token')?response(res,200,{token:TOKEN}):req.method==='HEAD'?response(res,200):req.headers.authorization?response(res,200,MANIFEST):response(res,401,{},CHALLENGE));
  await imagePreflight(h.r,h.dir);assert.deepEqual(h.requests.map(x=>x.method),['HEAD','GET','GET','GET']);
});
test('a public image without a challenge needs no token request',async t=>{
  const h=await setup(t,(req,res)=>response(res,200,req.method==='HEAD'?undefined:MANIFEST));
  const result=await verifyImage(h.r,h.dir,{registry:REGISTRY,repository:'tsa/policy',tag:'1.0.0'});
  assert.equal(result.authentication,'anonymous');assert.deepEqual(h.requests.map(x=>x.method),['HEAD','GET']);
});
for(const failure of ['token-denied','pull-denied','missing-token','malformed-token','helm-artifact','head-400','get-404','redirect'])test(`registry ${failure} stops preflight, removes private files and keeps diagnostics credential-free`,async t=>{
  const h=await setup(t,(req,res)=>{
    if(req.url.startsWith('/service/token'))return response(res,failure==='token-denied'?401:200,failure==='missing-token'?null:failure==='malformed-token'?'broken JSON':{token:TOKEN});
    if(failure==='head-400')return response(res,400);
    if(failure==='redirect') {res.writeHead(302,{Location:'https://unrelated.invalid/token'});return res.end();}
    if(req.headers.authorization!==`Bearer ${TOKEN}`)return response(res,401,{},CHALLENGE);
    if(failure==='pull-denied')return response(res,403);
    if(req.method==='HEAD')return response(res,200);
    if(failure==='get-404')return response(res,404);
    response(res,200,failure==='helm-artifact'?{schemaVersion:2,config:{mediaType:'application/vnd.cncf.helm.config.v1+json'}}:MANIFEST);
  });
  await assert.rejects(imagePreflight(h.r,h.dir),e=>e.code==='POLICY_IMAGE'&&!e.message.includes(TOKEN));
  assert.deepEqual(await fs.readdir(h.dir),[]);assert.ok(!JSON.stringify(h.calls).includes(TOKEN));
  if(failure==='pull-denied')assert.equal(h.requests.length,3,'do not loop on denied bearer authentication');
  if(failure==='head-400'||failure==='redirect')assert.equal(h.requests.length,1);
});
test('cancellation propagates while a registry request is running and cleans up',async t=>{
  let started;const requestStarted=new Promise(resolve=>{started=resolve;});
  const h=await setup(t,(req,res)=>{started();req.on('close',()=>res.end());});
  const controller=new AbortController();h.r.signal=controller.signal;
  const operation=imagePreflight(h.r,h.dir);await requestStarted;controller.abort();
  await assert.rejects(operation,{code:'CANCELLED'});assert.deepEqual(await fs.readdir(h.dir),[]);
});
test('Bearer challenge uses only final response headers and rejects unsupported/insecure malformed challenges',()=>{
  const h=challenge(`HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 401\r\nwWw-AuThEnTiCaTe: ${CHALLENGE}\r\n\r\n`);
  assert.equal(h.realm.href,`https://${REGISTRY}/service/token`);assert.equal(h.service,'harbor-registry');
  for(const value of ['Basic realm="private"','Bearer realm="http://registry/token"','Bearer realm="https://user:password@registry/token"','Bearer service="registry"','Bearer realm="https://registry/token",realm="https://other/token"','Bearer realm="https://registry/token",broken'])assert.throws(()=>challenge(`HTTP/2 401\r\nWWW-Authenticate: ${value}\r\n\r\n`));
});
test('manifest validation accepts container images and image indexes, rejects Helm indexes',()=>{
  assert.ok(imageManifest(MANIFEST));
  const index={schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{mediaType:'application/vnd.oci.image.manifest.v1+json'}]};
  assert.ok(imageManifest(index));index.manifests[0].artifactType='application/vnd.cncf.helm.chart.content.v1.tar+gzip';assert.ok(!imageManifest(index));
  assert.ok(!imageManifest({schemaVersion:2,manifests:[{}]}));
});
