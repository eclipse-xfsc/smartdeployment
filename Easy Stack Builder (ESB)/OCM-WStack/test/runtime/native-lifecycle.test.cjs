'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {Adapters}=require('../../runtime/lib/adapters.cjs'),{Events}=require('../../runtime/lib/events.cjs'),{summarize,statusRef}=require('../../runtime/lib/credentials.cjs'),{graph}=require('../../runtime/lib/provenance.cjs'),{request}=require('../../runtime/lib/http.cjs'),{Runtime}=require('../../runtime/lib/runtime.cjs');
const config={tenant:'tenant',account:'wallet',group:'wallet',cryptoNamespace:'ocm-wstack',cryptoGroup:'tenant',publicOrigin:'https://wallet.example',issuerDids:['did:web:wallet.example']},context={...config,subject:'user-1',username:'Mani',token:'user-token'};
const payload={iss:config.issuerDids[0],vct:'SDJWT',cnf:{jwk:{kty:'EC',crv:'P-256',kid:'eckey',x:'public-x',y:'public-y'}},exp:4102444800,status:{status_list:{idx:1,uri:config.publicOrigin+'/api/status/2'}}};
const token=(p=payload)=>'e30.'+Buffer.from(JSON.stringify(p)).toString('base64url')+'.signature~';
const native=(reply,records={one:token()})=>new Adapters(config,{call:async(n,p,o)=>n==='storage'?{credentials:records}:reply(n,p,o)});
test('SD-JWT holder display uses key binding without inventing a person or verified identity',()=>{
 const s=summarize('one',token());assert.equal(s.subject.id,null);assert.equal(s.holder.kind,'key-binding');assert.match(s.holder.label,/P-256.*eckey/);assert.equal(s.status.state,'not_checked');assert.ok(s.expiresAt);
 const g=graph({one:token()},'one');assert.equal(g.verified,false);assert.ok(g.edges.some(e=>e.role==='holder'&&e.verified===false));
});
test('current SD-JWT status reference routes to native list/index and cannot escape tenant authority',()=>{
 assert.deepEqual(statusRef(token(),config),{listId:'2',index:1,url:payload.status.status_list.uri,type:'TokenStatusList'});
 for(const changed of [{iss:'did:web:foreign.example'},{status:{status_list:{idx:1,uri:'https://evil.example/api/status/2'}}},{status:{status_list:{idx:-1,uri:payload.status.status_list.uri}}},{status:{status_list:{idx:1.5,uri:payload.status.status_list.uri}}}])assert.throws(()=>statusRef(token({...payload,...changed}),config));
});
test('Revoke sends one native mutation and trusts only the exact native acknowledgement',async t=>{
 let calls=0;const server=http.createServer((req,res)=>{calls++;assert.equal(req.method,'POST');assert.equal(req.url,'/status/tenant/2/revoke/1');assert.equal(req.headers['x-tenantid'],'tenant');assert.equal(req.headers.authorization,'Bearer user-token');res.setHeader('content-type','application/json');res.end(JSON.stringify({tenantId:'tenant',listId:2,index:1,status:'revoked'}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const a=native((n,p,o)=>{assert.equal(n,'status');return request('http://127.0.0.1:'+server.address().port+p,o);});
 a.statusTransport={checkStatus:()=>assert.fail('revocation must not rely on wallet status checks')};
 const r=await a.revoke(context,'one');assert.equal(calls,1);assert.equal(r.state,'succeeded');assert.equal(r.confirmation,'native-acknowledgement');assert.equal(r.verification,undefined);
});
test('wrong-scope and malformed revoke acknowledgements remain outcome unknown',async()=>{
 for(const reply of [null,{tenantId:'other',listId:2,index:1,status:'revoked'},{tenantId:'tenant',listId:3,index:1,status:'revoked'},{tenantId:'tenant',listId:2,index:0,status:'revoked'},{tenantId:'tenant',listId:2,index:1,status:'active'}])await assert.rejects(native(async()=>reply).revoke(context,'one'),{code:'OPERATION_OUTCOME_UNKNOWN'});
});
test('deletion calls only native Storage and never implicitly revokes',async()=>{let writes=[];const a=native(async()=>assert.fail('Status must not be called'));a.http={call:async(n,p,o)=>{writes.push({n,p,o});}};await a.remove(context,'one');assert.equal(writes.length,1);assert.equal(writes[0].n,'storage');assert.equal(writes[0].o.method,'DELETE');});
test('native Signer verdict is preserved without a OCM expiry, proof or status decision',async()=>{
 for(const valid of [true,false]){const a=native(async(n,p,o)=>{assert.equal(n,'signer');assert.equal(Buffer.from(o.body.credential,'base64').toString(),token());assert.equal(o.headers['x-format'],'dc+sd-jwt');assert.deepEqual(o.body.disclosureFrame,[]);return {valid};});const r=await a.verify(context,'one');assert.equal(r.overall,valid?'valid':'invalid');assert.equal(r.nativeValid,valid);assert.equal(r.cryptographic.state,'not_separately_reported');assert.equal(r.status.state,'not_separately_reported');}
});
test('native verification rejection includes safe transport evidence and never becomes valid or invalid',async()=>{
 const a=native(async()=>{throw Object.assign(Error('secret credential claims must not leak'),{status:503,code:'UPSTREAM_REJECTED',upstreamStatus:500});});const r=await a.verify(context,'one');assert.equal(r.overall,'indeterminate');assert.equal(r.code,'UPSTREAM_REJECTED');assert.equal(r.upstreamStatus,500);assert.ok(!JSON.stringify(r).includes('secret credential'));assert.equal(r.nativeValid,undefined);
});
test('native status request preserves configured crypto scope and validates correlation',async()=>{
 const e=new Events(config);e.connected=true;e.nc={request:async(subject,bytes)=>{assert.equal(subject,'status.data');const event=JSON.parse(bytes);assert.equal(event.type,'status.data.verify');assert.equal(event.data.type,'TokenStatusList');assert.equal(event.data.namespace,config.cryptoNamespace);assert.equal(event.data.group,config.cryptoGroup);assert.equal(event.data.statusUrl,payload.status.status_list.uri);return {data:Buffer.from(JSON.stringify({specversion:'1.0',type:'status.data',data:{tenant_id:'tenant',request_id:event.data.request_id,revocated:true,suspended:false}}))};}};
 const r=await e.checkStatus(context,statusRef(token(),config),config);assert.deepEqual(r,{revocated:true,suspended:false});
});
test('native status replies reject cross-tenant, wrong correlation, errors and malformed flags',async()=>{
 for(const changed of [{tenant_id:'foreign'},{request_id:'wrong'},{error:{msg:'sensitive'}},{revocated:'true'}]){const e=new Events(config);e.connected=true;e.nc={request:async(s,b)=>({data:Buffer.from(JSON.stringify({specversion:'1.0',type:'status.data',data:{tenant_id:'tenant',request_id:JSON.parse(b).data.request_id,revocated:false,suspended:false,...changed}}))})};await assert.rejects(e.checkStatus(context,statusRef(token(),config),config));}
});
test('native status errors stay visible and never become active; checks are bounded',async()=>{
 const records=Object.fromEntries(Array.from({length:30},(_,i)=>['c'+i,token({...payload,status:{status_list:{idx:i,uri:payload.status.status_list.uri}}})]));const a=native(async()=>assert.fail('no direct bit list reads'),records);let checks=0;a.statusTransport={checkStatus:async()=>{checks++;throw Object.assign(Error(),{code:'NATIVE_STATUS_REJECTED'});}};
 const r=await a.list(context);assert.equal(checks,16);assert.equal(r.counts.active,0);assert.equal(r.counts.notChecked,30);assert.ok(r.items.some(i=>i.status.reason==='NATIVE_STATUS_REJECTED'));
});
test('verification history distinguishes requesting user from native verifier and stores no credential',async()=>{
 const r=new Runtime(config);let stored;r.adapters.verify=async()=>({service:'XFSC Signer',overall:'indeterminate',code:'UPSTREAM_REJECTED',cryptographic:{state:'not_separately_reported'},status:{state:'not_separately_reported'}});r.db={collection:n=>{assert.equal(n,'verification_events');return {insertOne:async d=>stored=d};}};
 const result=await r.execute('verify',context,'one',{}, {},'req-one');assert.equal(stored.verifier,'user-1');assert.equal(stored.verifierName,'Mani');assert.equal(stored.service,'XFSC Signer');assert.equal(stored.code,'UPSTREAM_REJECTED');assert.equal(result.requestedBy.username,'Mani');assert.ok(!JSON.stringify(stored).includes('signature~'));
});
