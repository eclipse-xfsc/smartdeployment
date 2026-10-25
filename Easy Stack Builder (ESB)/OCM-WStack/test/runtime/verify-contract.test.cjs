'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {Adapters}=require('../../runtime/lib/adapters.cjs'),{Client}=require('../../runtime/lib/http.cjs');
test('native verification HTTP contract preserves bytes, scoped Storage and unscoped Crypto',async t=>{
 const ldp=' {"type":["VerifiableCredential"],"issuer":"did:web:example.com","credentialSubject":{"id":"did:example:holder"}}\n';
 const jwt='e30.'+Buffer.from(JSON.stringify({iss:'did:web:example.com',vct:'Test'})).toString('base64url')+'.signature~disclosure~';
 const records={ldp,jwt};let key,valid=true,malformed=false;const seen=[];
 const server=http.createServer(async(req,res)=>{
  seen.push(req.url);res.setHeader('content-type','application/json');
  if(req.url.startsWith('/v1/tenants/')){
   assert.equal(req.method,'POST');assert.equal(req.headers['x-tenantid'],'tenant');assert.equal(req.headers['x-groupid'],'ocm');
   return res.end(JSON.stringify({credentials:records}));
  }
  assert.equal(req.url,'/v1/credential/verify');assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Bearer token');
  for(const name of ['x-tenantid','x-groupid','x-namespace','x-group','x-origin'])assert.equal(req.headers[name],undefined,name);
  assert.equal(req.headers['x-format'],key==='ldp'?'ldp_vc':'dc+sd-jwt');
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
  assert.equal(Buffer.from(body.credential,'base64').toString(),records[key]);
  assert.deepEqual(Object.keys(body).sort(),key==='ldp'?['credential']:['credential','disclosureFrame']);
  if(key==='jwt')assert.deepEqual(body.disclosureFrame,[]);
  res.end(JSON.stringify(malformed?{valid:'true'}:{valid}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const origin='http://127.0.0.1:'+server.address().port,c={tenant:'tenant',group:'ocm',account:'ocm',token:'token'};
 const a=new Adapters({storageRegion:'EU',storageCountry:'DE',cryptoNamespace:'ocm-wstack',cryptoGroup:'scope',publicOrigin:'https://example.com'},new Client({storage:origin,signer:origin}));
 for(key of ['ldp','jwt'])for(valid of [true,false]){
  const r=await a.verify(c,key);assert.equal(r.nativeValid,valid);assert.equal(r.overall,valid?'valid':'invalid');
  assert.equal(r.status.state,key==='ldp'?'not_checked':'not_separately_reported');
 }
 key='jwt';malformed=true;const r=await a.verify(c,key);assert.equal(r.overall,'indeterminate');assert.equal(r.code,'UPSTREAM_PROTOCOL_ERROR');assert.equal(seen.length,10);
});
