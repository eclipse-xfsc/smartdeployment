'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {parseApiBody,MAX_BYTES}=require('../../runtime/lib/api-body.cjs');
const {Runtime}=require('../../runtime/lib/runtime.cjs');
async function server(t,after,before){
 const s=http.createServer((req,res)=>{res.json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};res.status=n=>{res.statusCode=n;return res;};before?.(req);parseApiBody(req,res,()=>after(req,res));});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));return 'http://127.0.0.1:'+s.address().port;
}
test('JSON mutation bodies reach real runtime authentication without dispatch',async t=>{
 const app=new Runtime({services:{},credentialTypes:[]});app.ready=true;app.auth=new (require('../../runtime/lib/local-auth.cjs').LocalAuth)({},null,null);app.execute=()=>assert.fail('unauthenticated mutation');
 const origin=await server(t,(req,res)=>{assert.equal(req._body,true);assert.deepEqual(req.body,{});return app.handle(req,res);});
 const checks=await require('../../lib/api-check').checks(origin,{requester:require('../../lib/native').request});assert.equal(checks.length,3);assert.ok(checks.every(x=>x.ok),JSON.stringify(checks));
});
test('HTTP POST issuance retains exact claims and idempotency header through parsed request',async t=>{
 const body={credentialConfigurationId:'SDJWTCredential',claims:{given_name:'Ada',family_name:'Lovelace'}};
 const origin=await server(t,(req,res)=>{assert.equal(req._body,true);assert.deepEqual(req.body,body);assert.equal(req.headers['x-idempotency-key'],'fixed-key-123456');res.json({data:{state:'succeeded'}});},req=>{req.body={};});
 const r=await fetch(origin+'/orce/ui-api/v1/issuance',{method:'POST',headers:{'content-type':'application/json','x-idempotency-key':'fixed-key-123456'},body:JSON.stringify(body)});assert.equal(r.status,200);assert.equal((await r.json()).data.state,'succeeded');
});
test('invalid/oversized/unsupported request bodies return bounded JSON errors before mutation',async t=>{
 const origin=await server(t,()=>assert.fail('must not dispatch'));
 for(const [body,headers,status,code] of [['{',{'content-type':'application/json'},400,'INVALID_JSON_BODY'],['[]',{'content-type':'application/json'},400,'INVALID_JSON_BODY'],['"text"',{'content-type':'application/json'},400,'INVALID_JSON_BODY'],['{}',{'content-type':'text/plain'},415,'JSON_CONTENT_TYPE_REQUIRED'],['{}',{'content-type':'application/json','content-encoding':'gzip'},415,'UNSUPPORTED_CONTENT_ENCODING'],[JSON.stringify({value:'x'.repeat(MAX_BYTES)}),{'content-type':'application/json'},413,'REQUEST_TOO_LARGE']]){
  const r=await fetch(origin+'/orce/ui-api/v1/issuance',{method:'POST',headers,body});assert.equal(r.status,status);const d=await r.json();assert.equal(d.error.code,code);assert.equal(r.headers.get('x-request-id'),d.requestId);assert.equal(r.headers.get('cache-control'),'no-store');
 }
});
test('already parsed bodies are retained and unrelated routes stay untouched',async t=>{
 const body={claims:{given_name:'Ada'}};const origin=await server(t,(req,res)=>{assert.equal(req.body,body);assert.equal(req._body,true);res.end('ok');},req=>{req.body=body;req._body=true;});
 assert.equal((await fetch(origin+'/orce/ui-api/v1/issuance',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,200);
 let next=0;parseApiBody({url:'/orce/editor/flows',method:'POST'},null,()=>next++);assert.equal(next,1);
});
test('deployer rejects a plain-text 500 and accepts only authenticated API boundary responses',async()=>{
 for(const response of [{status:500,data:null},{status:200,data:{}},{status:503,data:{error:{code:'OTHER'}}}])assert.ok((await require('../../lib/api-check').checks('https://example.test',{requester:async()=>response})).every(x=>!x.ok));
});
