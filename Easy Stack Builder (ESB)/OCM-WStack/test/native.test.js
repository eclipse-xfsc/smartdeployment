'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {exercise,metadataChecks,request}=require('../lib/native');
const c={tenantId:'demo-tenant',tenantUrl:'https://demo-tenant.example.com'};
const response=(data,status=200)=>({data,status,ok:status>=200&&status<300});
const requestId='11111111-1111-4111-8111-111111111111';
const credential='eyJwt.eyBody.signature~disclosure~';
function nativeMock({storage400=false,accept400=false}={}) {
  let stored=false;const calls=[];
  return {calls,requester:async(url,options={})=>{
    calls.push([url,options]);
    if(url.endsWith('/test/offering/create'))return response({offer:{credential_offer:'openid-credential-offer://?credential_offer=private-offer'}});
    if(url.includes('/retrieve/')){assert.equal(options.method,'PUT');assert.deepEqual(options.body,{credential_offer:'openid-credential-offer://?credential_offer=private-offer'});return response(requestId);}
    if(url.includes('/list/'))return response([{requestId}]);
    if(url.includes('/clear/')){assert.equal(options.method,'DELETE');assert.equal(options.body.holderGroup,c.tenantId);if(accept400)return response({error:'private failure'},400);stored=true;return response({credentials:[{credential}]});}
    if(url.endsWith('/credentials'))return storage400?response({message:'Region Id Missing.'},400):response({groups:stored?[{credentials:{id:credential}}]:[]});
    throw new Error('Unexpected native URL');
  }};
}
test('native flow uses one unconsumed offering, accepts it and proves exact credential read-back',async()=>{
  const mock=nativeMock();const report=await exercise(c,{...mock,retrieval:'http://localhost:1',storage:'http://localhost:2',pollSeconds:0});
  assert.equal(report.status,'passed');assert.equal(report.credentialLifecycle,'retrieved-and-read-back');assert.equal(report.credentialCount,1);
  const text=JSON.stringify(report);assert.ok(!text.includes(credential));assert.ok(!text.includes('private-offer'));assert.equal(mock.calls.filter(([u])=>u.includes('/test/offering/create')).length,1);
});
test('Storage HTTP 400 cannot be hidden by successful retrieval',async()=>{
  const report=await exercise(c,{...nativeMock({storage400:true}),retrieval:'http://localhost:1',storage:'http://localhost:2',pollSeconds:0});
  assert.equal(report.status,'failed');assert.equal(report.credentialLifecycle,'retrieved-storage-unverified');assert.equal(report.checks[0].reason,'Region Id Missing.');assert.equal(report.checks.find(x=>x.name==='retrieval-acceptance').ok,true);
});
test('acceptance failure preserves preceding retrieval evidence',async()=>{
  const report=await exercise(c,{...nativeMock({accept400:true}),retrieval:'http://localhost:1',storage:'http://localhost:2'});
  assert.equal(report.status,'failed');assert.equal(report.checks.at(-1).httpStatus,400);assert.equal(report.requestId,requestId);
});
test('HTTP 200 with the wrong tenant metadata does not pass validation',async()=>{
  const checks=await metadataChecks(c.tenantUrl,{requester:async()=>response({})});assert.ok(checks.every(x=>!x.ok));
});
test('HTTP request uses real JSON bodies and reports 400 without leaking its body',async t=>{
  const http=require('node:http');let body='';
  const server=http.createServer((req,res)=>{req.on('data',x=>body+=x);req.on('end',()=>{res.writeHead(400,{'content-type':'application/json'});res.end('{"message":"Region Id Missing."}');});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await request(`http://127.0.0.1:${server.address().port}/native`,{method:'POST',body:{}});
  assert.equal(result.status,400);assert.equal(result.ok,false);assert.equal(body,'{}');
});
