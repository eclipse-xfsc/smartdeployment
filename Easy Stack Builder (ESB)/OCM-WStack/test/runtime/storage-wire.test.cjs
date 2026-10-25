'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {Adapters}=require('../../runtime/lib/adapters.cjs'),{Client}=require('../../runtime/lib/http.cjs');
test('Storage 1.3.0 list sends exact native geography, required JSON type, zero bytes and preserves authenticated scope',async t=>{
 const seen=[],server=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{
  seen.push({path:req.url,body,headers:req.headers});res.setHeader('content-type','application/json');
  if(req.headers['content-type']!=='application/json'){res.statusCode=400;return res.end(JSON.stringify({message:'Bad content type'}));}
  res.end(JSON.stringify({}));
 });});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const c={tenant:'test-tenant',group:'ocm-wstack',account:'ocm-wstack',cryptoNamespace:'ocm-wstack',cryptoGroup:'test-tenant',publicOrigin:'https://ocm.example'};
 const a=new Adapters(c,new Client({storage:`http://127.0.0.1:${server.address().port}/`}));const listed=await a.list({...c,token:''});assert.deepEqual(listed.items,[]);assert.equal(listed.total,0);
 await a.records({...c,token:'user-token'});
 assert.ok(seen.every(x=>x.path==='/v1/tenants/test-tenant/storage/EU/DE/ocm-wstack/credentials'&&x.body===''));
 assert.equal(seen[0].headers.authorization,undefined);assert.equal(seen.at(-1).headers.authorization,'Bearer user-token');
 assert.equal(seen.at(-1).headers['x-tenantid'],'test-tenant');assert.equal(seen.at(-1).headers['x-groupid'],'ocm-wstack');
});
