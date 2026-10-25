'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {Adapters}=require('../../runtime/lib/adapters.cjs');
const {Client}=require('../../runtime/lib/http.cjs');
const {storageId}=require('../../runtime/lib/accepted-storage.cjs');
const config={publicOrigin:'https://ocm.example',storageRegion:'EU',storageCountry:'DE',holderKey:'eckey',cryptoNamespace:'ocm-wstack',cryptoGroup:'test-tenant'};
const context={tenant:'test-tenant',account:'ocm-wstack',group:'ocm-wstack',token:'user-token'};
const storagePath='/v1/tenants/test-tenant/storage/EU/DE/ocm-wstack/credentials';
const jwt='eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJpc3N1ZXIifQ.signature~disclosure~';
function fake({response={credentials:[{credential:jwt}]},initial={},putError,readBack=true}={}){
 const calls=[],records={...initial};
 const a=new Adapters(config,{call:async(name,path,options)=>{
  calls.push({name,path,options});
  if(name==='retrieval')return response;
  assert.equal(name,'storage');assert.equal(options.headers.authorization,'Bearer user-token');
  assert.equal(options.headers['content-type'],'application/json');
  if(options.method==='POST'){assert.equal(path,storagePath);assert.equal(options.body,undefined);return {credentials:{...records}};}
  assert.equal(options.method,'PUT');assert.ok(path.startsWith(storagePath+'/retrieval-'));
  if(putError)throw putError;
  if(readBack)records[path.split('/').at(-1)]=options.body;
  return null;
 }});
 return {a,calls,records};
}
test('accepted SD-JWT is persisted in the complete native scope and exact payload read back',async()=>{
 const {a,calls,records}=fake();const result=await a.accept(context,'offer-a',true,{});
 assert.equal(result.state,'succeeded');assert.equal(result.storageConfirmation,'confirmed');
 assert.equal(records[result.credentialId],jwt);assert.equal(calls.filter(x=>x.name==='retrieval').length,1);
 assert.equal(calls[0].options.method,'DELETE');assert.equal(calls[0].options.body.holderGroup,'test-tenant');
 assert.equal(calls.filter(x=>x.options.method==='PUT').length,1);
 assert.ok(!JSON.stringify(result).includes(jwt));
});
test('a native event already stored in the correct scope does not produce another copy',async()=>{
 const {a,calls}=fake({initial:{'native-id':jwt}});const result=await a.accept(context,'offer-a',true,{});
 assert.equal(result.credentialId,'native-id');assert.equal(calls.filter(x=>x.options.method==='PUT').length,0);
});
test('identical credential under another returned shape reuses the existing native record',async()=>{
 const vc={type:['VerifiableCredential'],issuer:'did:example:issuer',credentialSubject:{id:'did:example:holder'}};
 const {a,calls}=fake({response:{credentials:[{credential:vc}]},initial:{'native-json':JSON.stringify(vc)}});
 assert.equal((await a.accept(context,'offer-a',true,{})).credentialId,'native-json');assert.equal(calls.filter(x=>x.options.method==='PUT').length,0);
});
test('batch response persists and confirms every credential without returning their contents',async()=>{
 const {a,records}=fake({response:{credentials:[{credential:jwt},{credential:jwt+'second'}]}});
 const result=await a.accept(context,'offer-b',true,{});
 assert.equal(result.storageConfirmation,'confirmed');assert.equal(result.credentialIds.length,2);assert.equal(Object.keys(records).length,2);assert.equal(result.credentialId,undefined);
});
test('PUT acknowledgement and unrelated count increase are not persistence confirmation',async()=>{
 const {a}=fake({readBack:false,initial:{other:'different.jwt'}});const result=await a.accept(context,'offer-a',true,{});
 assert.equal(result.state,'unknown');assert.equal(result.storageConfirmation,'unconfirmed');assert.equal(result.code,'ACCEPTED_STORAGE_UNCONFIRMED');
});
test('Storage timeout cannot reissue or repeat the native acceptance/PUT',async()=>{
 const {a,calls}=fake({putError:{code:'UPSTREAM_TIMEOUT'}});const result=await a.accept(context,'offer-a',true,{});
 assert.equal(result.state,'unknown');assert.equal(result.accepted,true);assert.equal(result.storageError,'UPSTREAM_TIMEOUT');
 assert.equal(calls.filter(x=>x.name==='retrieval').length,1);assert.equal(calls.filter(x=>x.options.method==='PUT').length,1);
});
test('missing/deferred/oversized response never reports accepted credentials as persisted',async()=>{
 for(const response of [null,{transaction_id:'later'},{credentials:[]},{credentials:[{credential:null}]},{credentials:Array.from({length:33},()=>({credential:jwt}))},{credentials:[{credential:'x'.repeat(2097153)}]}]){
  const {a,calls}=fake({response});const result=await a.accept(context,'offer-a',true,{});
  assert.equal(result.state,'unknown');assert.equal(result.code,'ACCEPTED_CREDENTIAL_RESPONSE_INVALID');assert.equal(calls.length,1);
 }
});
test('reject does not list or write Storage',async()=>{
 const {a,calls}=fake({response:null});assert.deepEqual(await a.accept(context,'offer-a',false,{}),{state:'succeeded',upstreamRequestId:'offer-a',accepted:false});assert.equal(calls.length,1);
});
test('storage identifiers are stable, scope-specific and content-specific',()=>{
 const key=storageId(context,'offer-a',0,jwt);assert.equal(key,storageId(context,'offer-a',0,jwt));
 for(const changed of [{tenant:'other'},{account:'other'},{group:'other'}])assert.notEqual(key,storageId({...context,...changed},'offer-a',0,jwt));
 assert.notEqual(key,storageId(context,'offer-b',0,jwt));assert.notEqual(key,storageId(context,'offer-a',1,jwt));assert.notEqual(key,storageId(context,'offer-a',0,jwt+'changed'));
});
test('real HTTP sends raw compact credential bytes through native PUT, never JSON quotes',async t=>{
 const records={},calls=[];const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  calls.push({method:req.method,path:req.url,body,headers:req.headers});
  res.setHeader('content-type','application/json');
  if(req.method==='DELETE')return res.end(JSON.stringify({credentials:[{credential:jwt}]}));
  if(req.method==='PUT'){records[req.url.split('/').at(-1)]=body;return res.end();}
  res.end(JSON.stringify({credentials:records}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port;const a=new Adapters(config,new Client({retrieval:url,storage:url}));
 const result=await a.accept(context,'offer-a',true,{});assert.equal(result.storageConfirmation,'confirmed');
 assert.equal(calls.find(x=>x.method==='PUT').body,jwt);assert.equal(calls.find(x=>x.method==='PUT').headers['content-type'],'application/json');
});
test('DeveloperCredential rejection returns a safe exact reason and never writes Storage',async t=>{
 const paths=[];const server=http.createServer((req,res)=>{paths.push(req.url);res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:'failed to fetch credential data for accepted offering: wallet validation rejected issued credential\ncredential[0]: wallet verification currently requires a compact JWT or SD-JWT credential'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const url='http://127.0.0.1:'+server.address().port;
 const a=new Adapters(config,new Client({retrieval:url,storage:url}));
 await assert.rejects(a.accept(context,'offer-a',true,{}),{code:'RETRIEVAL_CREDENTIAL_FORMAT_UNSUPPORTED',reason:'RETRIEVAL_CREDENTIAL_FORMAT_UNSUPPORTED',status:422,upstreamStatus:400});
 assert.equal(paths.length,1);assert.ok(paths[0].includes('/offering/clear/'));
});
